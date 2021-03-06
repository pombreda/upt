var util = require('util');
var url = require('url');
var Q = require('q');
var mout = require('mout');
var LRU = require('lru-cache');
var path = require('path');
var GitResolver = require('./GitResolver');
var fs = require('graceful-fs');
var cmd = require('../../util/cmd');
var Utils = require('../../util/Utils');

function GitRemoteResolver (decEndpoint, config, logger) {
    GitResolver.call(this, decEndpoint, config, logger);

    if (!mout.string.startsWith(this._source, 'file://')) {
        // Trim trailing slashes
        this._source = this._source.replace(/\/+$/, '');
    }

    // If the name was guessed, remove the trailing .git
    if (this._guessedName && mout.string.endsWith(this._name, '.git')) {
        this._name = this._name.slice(0, -4);
    }

    // Get the host of this source
    if (!/:\/\//.test(this._source)) {
        this._host = url.parse('ssh://' + this._source).host;
    } else {
        this._host = url.parse(this._source).host;
    }

    this._updatedDirectly = false;
    this._canDtUpdate = false;

    if (decEndpoint.name && !Utils.isDynName(decEndpoint.name)) {
        this._workingDir = path.join(this._config.cwd, this._config.directory, decEndpoint.name);
        this._canDtUpdate = true;
    }
}

util.inherits(GitRemoteResolver, GitResolver);
mout.object.mixIn(GitRemoteResolver, GitResolver);

// -----------------

GitRemoteResolver.prototype._checkout = function () {
    var promise;
    var timer;
    var reporter;
    var that = this;
    var resolution = this._resolution;

    if (this._config.options.directUpdate && this._canDtUpdate && resolution.type !== "version") {
        this._updatedDirectly = true;

        this._logger.action('direct-update', resolution.tag || resolution.branch || resolution.commit, {
            resolution: resolution,
            to: this._workingDir
        });

        return cmd('git', ['status', '--untracked-files=no', '--porcelain'], {cwd: this._workingDir})
                .then(function (res) {
                    function update () {
                        return cmd('git', ['fetch', 'origin'], {cwd: that._workingDir})
                                .then(function () {
                                    return cmd('git', ['reset', '--hard', resolution.commit || 'origin/' + resolution.branch], {cwd: that._workingDir})
                                            .then(function () {
                                                that._logger.action('updated', that._workingDir);
                                            });
                                });
                    }

                    if (res[0]) {
                        // If there are uncommitted changes, alert.
                        return Q.nfcall(that._logger.prompt.bind(that._logger), {
                            type: 'input',
                            message: 'There are uncommitted changes on ' + this._workingDir + ' that will be deleted. Do you want continue? [yes/no]',
                            validate: function (choice) {
                                choice = Number(mout.string.trim(choice.trim(), '!'));

                                if (choice.toLowerCase() !== "yes" || choice.toLowerCase() !== "no") {
                                    return 'Invalid choice';
                                }

                                return true;
                            }
                        }).then(function (choice) {
                            return choice.toLowerCase() === "yes" && update() || process.exit();
                        }.bind(this));
                    } else {
                        return update();
                    }
                });
    } else {
        this._logger.action('checkout', resolution.tag || resolution.branch || resolution.commit, {
            resolution: resolution,
            to: this._workingDir
        });

        return this._createTempDir().then(function () {
            // If resolution is a commit, we need to clone the entire repo and check it out
            // Because a commit is not a named ref, there's no better solution
            // [TODO] add a parameter to force the slowClone
            if (resolution.type === 'commit' /*|| (!this._config.options.production && this._config.argv.remain[0] !== "info")*/) {
                promise = this._slowClone(resolution);
                // Otherwise we are checking out a named ref so we can optimize it
            } else {
                promise = this._fastClone(resolution);
            }

            // Throttle the progress reporter to 1 time each sec
            reporter = mout.fn.throttle(function (data) {
                var lines;
                lines = data.split(/[\r\n]+/);
                lines.forEach(function (line) {
                    if (/\d{1,3}\%/.test(line)) {
                        // TODO: There are some strange chars that appear once in a while (\u001b[K)
                        //       Trim also those?
                        that._logger.info('progress', line.trim());
                    }
                });
            }, 1000);

            // Start reporting progress after a few seconds
            timer = setTimeout(function () {
                promise.progress(reporter);
            }, 8000);

            return promise
                    // Add additional proxy information to the error if necessary
                    .fail(function (err) {
                        that._suggestProxyWorkaround(err);
                        throw err;
                    })
                    // Clear timer at the end
                    .fin(function () {
                        clearTimeout(timer);
                        reporter.cancel();
                    });
        }.bind(this));
    }
};

GitRemoteResolver.prototype._findResolution = function (target) {
    var that = this;

    // Override this function to include a meaningful message related to proxies
    // if necessary
    return GitResolver.prototype._findResolution.call(this, target)
            .fail(function (err) {
                that._suggestProxyWorkaround(err);
                throw err;
            });
};

// ------------------------------

GitRemoteResolver.prototype._slowClone = function (resolution) {
    var args = ['clone', this._source, this._workingDir, '--progress'];

    // point to specified branch
    if (resolution.branch)
        args.push('-b', resolution.branch);

    return cmd('git', args)
            // reset repository to requested commit
            .then(cmd.bind(cmd, 'git', ['reset', resolution.commit, '--hard'], {cwd: this._workingDir}));
};

GitRemoteResolver.prototype._fastClone = function (resolution) {
    var branch,
            args,
            that = this;

    branch = resolution.tag || resolution.branch;
    args = ['clone', this._source, '-b', branch, '--progress', '.'];

    // If the host does not support shallow clones, we don't use --depth=1
    if (!GitRemoteResolver._noShallow.get(this._host)) {
        args.push('--depth', 1);
    }

    return cmd('git', args, {cwd: this._workingDir})
            .spread(function (stdout, stderr) {
                // Only after 1.7.10 --branch accepts tags
                // Detect those cases and inform the user to update git otherwise it's
                // a lot slower than newer versions
                if (!/branch .+? not found/i.test(stderr)) {
                    return;
                }

                that._logger.warn('old-git', 'It seems you are using an old version of git, it will be slower and propitious to errors!');
                return cmd('git', ['checkout', resolution.commit], {cwd: that._workingDir});
            }, function (err) {
                // Some git servers do not support shallow clones
                // When that happens, we mark this host and try again
                if (!GitRemoteResolver._noShallow.has(that._source) &&
                        err.details &&
                        /(rpc failed|shallow|--depth)/i.test(err.details)
                        ) {
                    GitRemoteResolver._noShallow.set(that._host, true);
                    return that._fastClone(resolution);
                }

                throw err;
            });
};

GitRemoteResolver.prototype._suggestProxyWorkaround = function (err) {
    if ((this._config.proxy || this._config.httpsProxy) &&
            mout.string.startsWith(this._source, 'git://') &&
            err.code === 'ECMDERR' && err.details
            ) {
        err.details = err.details.trim();
        err.details += '\n\nWhen under a proxy, you must configure git to use https:// instead of git://.';
        err.details += '\nYou can configure it for every endpoint or for this specific host as follows:';
        err.details += '\ngit config --global url."https://".insteadOf git://';
        err.details += '\ngit config --global url."https://' + this._host + '".insteadOf git://' + this._host;
        err.details += 'Ignore this suggestion if you already have this configured.';
    }
};

GitRemoteResolver.prototype._savePkgMeta = function (meta, dir, uptName, skipWrite) {
    return GitResolver.prototype._savePkgMeta.call(this, meta, dir, this._updatedDirectly ? ".upt.json.new" : uptName, skipWrite);
};

// ------------------------------

// Grab refs remotely
GitRemoteResolver.refs = function (source) {
    var value;

    // TODO: Normalize source because of the various available protocols?
    value = this._cache.refs.get(source);
    if (value) {
        return Q.resolve(value);
    }

    // Store the promise in the refs object
    value = cmd('git', ['ls-remote', '--tags', '--heads', source])
            .spread(function (stdout) {
                var refs;

                refs = stdout.toString()
                        .trim()                         // Trim trailing and leading spaces
                        .replace(/[\t ]+/g, ' ')        // Standardize spaces (some git versions make tabs, other spaces)
                        .split(/[\r\n]+/);              // Split lines into an array

                // Update the refs with the actual refs
                this._cache.refs.set(source, refs);

                return refs;
            }.bind(this));

    // Store the promise to be reused until it resolves
    // to a specific value
    this._cache.refs.set(source, value);

    return value;
};

// Store hosts that do not support shallow clones here
GitRemoteResolver._noShallow = new LRU({max: 50, maxAge: 5 * 60 * 1000});

module.exports = GitRemoteResolver;
