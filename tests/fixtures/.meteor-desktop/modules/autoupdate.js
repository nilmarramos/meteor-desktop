/**
 This is a slightly modified JS port of hot code push android client from here:
 https://github.com/meteor/cordova-plugin-meteor-webapp

 The MIT License (MIT)

 Copyright (c) 2015 Meteor Development Group

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.

 This is based on:
 /cordova-plugin-meteor-webapp/blob/master/src/android/WebAppLocalServer.java

 */

var Module = require('./module.js');
var path = require('path');
var join = path.join;
var shell = require('shelljs');
var fs = require('fs');
var url = require('url');
var Log = require('./autoupdate/logger');

var AssetBundle = require('./autoupdate/assetBundle');
var AssetBundleManager = require('./autoupdate/assetBundleManager');

var winston = require('winston');
var log = new winston.Logger({
    level: 'debug',
    transports: [new winston.transports.Console(), new winston.transports.File({ filename: join(__dirname, '..', 'autoupdateModule.log') })]
});

/**
 * Represents the hot code push client.
 * Unlike the cordova implementation this does not have a builtin HTTP server.
 *
 * @constructor
 */
function HCPClient(l, app, settings, systemEvents) {
    var self = this;
    var autoupdateModule = new Module('autoupdateModule');

    this._l = new Log('HCPClient', log);

    systemEvents.on('initialization', this._init.bind(this));

    this._config = {
        appId: null,
        rootUrlString: null,
        cordovaCompatibilityVersion: null,
        blacklistedVersions: [],
        lastDownloadedVersion: null
    };

    this._configFile = join(__dirname, '..', 'autoupdateModule.json');
    this._versionsDir = join(__dirname, '..', 'versions');

    this._module = autoupdateModule;

    this._module.on('checkForUpdates', function checkForUpdates() {
        var rootUrl = self._currentAssetBundle.getRootUrlString();
        if (rootUrl === null) {
            module.send('error', 'checkForUpdates requires a rootURL to be configured');
            return;
        }

        self._assetBundleManager.checkForUpdates(url.resolve(rootUrl, '__cordova/'));
        self._event = null;
    });
}

/**
 * Performs initialization.
 *
 * @private
 */
HCPClient.prototype._init = function _init() {
    var initialAssetBundle;
    var lastDownloadedVersion;

    if (!fs.existsSync(this._configFile)) {
        this._saveConfig();
        this._l.log('info', 'Created empty autoupdateModule.json');
    }

    this._readConfig();

    this._l.log('debug', 'Reading initial version');
    initialAssetBundle = new AssetBundle(this._l.getUnwrappedLogger(), join(__dirname, '..', 'meteor'));

    // If the last seen initial version is different from the currently bundled
    // version, we delete the versions directory and unset lastDownloadedVersion
    // and blacklistedVersions
    /*
     if (!initialAssetBundle.getVersion().equals(configuration.getLastSeenInitialVersion()))  {
     Log.d(LOG_TAG, "Detected new bundled version, removing versions directory if it exists");
     if (versionsDirectory.exists()) {
     if (!IOUtils.deleteRecursively(versionsDirectory)) {
     Log.w(LOG_TAG, "Could not remove versions directory");
     }
     }
     configuration.reset();
     }*/

    // We keep track of the last seen initial version (see above)
    this._config.lastSeenInitialVersion = initialAssetBundle.getVersion();

    // If the versions directory does not exist, we create it
    if (!fs.existsSync(this._versionsDir)) {
        this._l.log('info', 'Created versions dir.');
        // TODO: try/catch
        shell.mkdir(this._versionsDir);
    }

    this._assetBundleManager = new AssetBundleManager(this._l.getUnwrappedLogger(), this._config, initialAssetBundle, this._versionsDir);

    this._assetBundleManager.setCallback(this);

    lastDownloadedVersion = this._config.lastDownloadedVersion;
    if (lastDownloadedVersion) {
        this._currentAssetBundle = this._assetBundleManager._downloadedAssetBundlesByVersion[lastDownloadedVersion];

        if (this._currentAssetBundle === null) {
            this._currentAssetBundle = initialAssetBundle;
        }
    } else {
        this._currentAssetBundle = initialAssetBundle;
    }

    this._config.appId = this._currentAssetBundle.getAppId();
    this._config.rootUrlString = this._currentAssetBundle.getRootUrlString();
    this._config.cordovaCompatibilityVersion = this._currentAssetBundle.cordovaCompatibilityVersion;

    this._saveConfig();

    this._pendingAssetBundle = null;
};

HCPClient.prototype.getPendingVersion = function getPendingVersion() {
    if (this._pendingAssetBundle !== null) {
        return this._pendingAssetBundle.getVersion();
    }
    return null;
};

/**
 * Returns the current assets bundle's directory.
 * @returns {string}
 */
HCPClient.prototype.getDirectory = function getDirectory() {
    return this._currentAssetBundle.getDirectoryUri();
};

/**
 * Returns the parent asset bundle's directory.
 * @returns {string|null}
 */
HCPClient.prototype.getParentDirectory = function getParentDirectory() {
    return this._currentAssetBundle.getParentAssetBundle() ? this._currentAssetBundle.getParentAssetBundle().getDirectoryUri() : null;
};

/**
 * This is fired when a new version is ready and we need to reset (reload) the Browser.
 */
HCPClient.prototype.onReset = function onReset() {
    // If there is a pending asset bundle, we make it the current
    if (this._pendingAssetBundle !== null) {
        this._currentAssetBundle = this._pendingAssetBundle;
        this._pendingAssetBundle = null;
    }

    this._l.log('info', 'Serving asset bundle with version: ' + this._currentAssetBundle.getVersion());

    this._config.appId = this._currentAssetBundle.getAppId();
    this._config.rootUrlString = this._currentAssetBundle.getRootUrlString();
    this._config.cordovaCompatibilityVersion = this._currentAssetBundle.cordovaCompatibilityVersion;

    this._saveConfig();

    // Don't start startup timer when running a test
    // if (testingDelegate == null) {
    //  startStartupTimer();
    // }
};

/**
 * Save the current config.
 * @private
 */
HCPClient.prototype._saveConfig = function _saveConfig() {
    fs.writeFileSync(this._configFile, JSON.stringify(this._config, null, '\t'));
};

/**
 * Reads config json file.
 * @private
 */
HCPClient.prototype._readConfig = function _readConfig() {
    // TODO: try/catch
    this._config = JSON.parse(fs.readFileSync(this._configFile, 'UTF-8'));
};

/**
 * Error callback fired by assetBundleManager.
 * @param cause
 */
HCPClient.prototype.onError = function onError(cause) {
    this._l.log('error', 'Download failure: ' + cause);
    this._notifyError(cause);
};

/**
 * Fires error callback from the meteor's side.
 *
 * @param {string} cause - Error message.
 * @private
 */
HCPClient.prototype._notifyError = function _notifyError(cause) {
    this._l.log('error', 'Download failure: ' + cause);
    this._module.send('error', '[autoupdate] Download failure: ' + cause);
};

/**
 * Makes downloaded asset pending. Fired by assetBundleManager.
 * @param assetBundle
 */
HCPClient.prototype.onFinishedDownloadingAssetBundle = function onFinishedDownloadingAssetBundle(assetBundle) {
    this._config.lastDownloadedVersion = assetBundle.getVersion();
    this._saveConfig();
    this._pendingAssetBundle = assetBundle;
    this._notifyNewVersionReady(assetBundle.getVersion());
};

/**
 * Notify meteor that a new version is ready.
 * @param {string} version - Version string.
 * @private
 */
HCPClient.prototype._notifyNewVersionReady = function _notifyNewVersionReady(version) {
    this._module.send('onNewVersionReady', version);
};

/**
 * Method that decides whether we are interested in the new bundle that we were notified about.
 *
 * @param {AssetManifest} manifest - Manifest of the new bundle.
 * @returns {boolean}
 */
HCPClient.prototype.shouldDownloadBundleForManifest = function shouldDownloadBundleForManifest(manifest) {
    var version = manifest.version;

    // No need to redownload the current version
    if (this._currentAssetBundle.getVersion() === version) {
        this._l.log('info', 'Skipping downloading current version: ' + version);
        return false;
    }

    // No need to redownload the pending version
    if (this._pendingAssetBundle !== null && this._pendingAssetBundle.getVersion() === version) {
        this._l.log('info', 'Skipping downloading pending version: ' + version);
        return false;
    }

    // Don't download blacklisted versions
    if (~this._config.blacklistedVersions.indexOf(version)) {
        this._notifyError('Skipping downloading blacklisted version: ' + version);
        return false;
    }

    // TODO: place for checking electron compatibility version

    return true;
};

module.exports = HCPClient;
//# sourceMappingURL=data:application/json;base64,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TCxDQUFhLElBQWIsQ0FDSSxtQkFESixFQUVJLE9BRko7QUFJSCxDQUxEOzs7Ozs7OztBQWFBLFVBQVUsU0FBVixDQUFvQiwrQkFBcEIsR0FDSSxTQUFTLCtCQUFULENBQXlDLFFBQXpDLEVBQW1EO0FBQy9DLFFBQUksVUFBVSxTQUFTLE9BQXZCOzs7QUFHQSxRQUFJLEtBQUssbUJBQUwsQ0FBeUIsVUFBekIsT0FBMEMsT0FBOUMsRUFBdUQ7QUFDbkQsYUFBSyxFQUFMLENBQVEsR0FBUixDQUFZLE1BQVosRUFBb0IsMkNBQTJDLE9BQS9EO0FBQ0EsZUFBTyxLQUFQO0FBQ0g7OztBQUdELFFBQUksS0FBSyxtQkFBTCxLQUE2QixJQUE3QixJQUNBLEtBQUssbUJBQUwsQ0FBeUIsVUFBekIsT0FBMEMsT0FEOUMsRUFDdUQ7QUFDbkQsYUFBSyxFQUFMLENBQVEsR0FBUixDQUFZLE1BQVosRUFBb0IsMkNBQTJDLE9BQS9EO0FBQ0EsZUFBTyxLQUFQO0FBQ0g7OztBQUdELFFBQUksQ0FBQyxLQUFLLE9BQUwsQ0FBYSxtQkFBYixDQUFpQyxPQUFqQyxDQUF5QyxPQUF6QyxDQUFMLEVBQXdEO0FBQ3BELGFBQUssWUFBTCxDQUFrQiwrQ0FBK0MsT0FBakU7QUFDQSxlQUFPLEtBQVA7QUFDSDs7OztBQUlELFdBQU8sSUFBUDtBQUNILENBMUJMOztBQTRCQSxPQUFPLE9BQVAsR0FBaUIsU0FBakIiLCJmaWxlIjoibW9kdWxlcy9hdXRvdXBkYXRlLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gVGhpcyBpcyBhIHNsaWdodGx5IG1vZGlmaWVkIEpTIHBvcnQgb2YgaG90IGNvZGUgcHVzaCBhbmRyb2lkIGNsaWVudCBmcm9tIGhlcmU6XG4gaHR0cHM6Ly9naXRodWIuY29tL21ldGVvci9jb3Jkb3ZhLXBsdWdpbi1tZXRlb3Itd2ViYXBwXG5cbiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcblxuIENvcHlyaWdodCAoYykgMjAxNSBNZXRlb3IgRGV2ZWxvcG1lbnQgR3JvdXBcblxuIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOlxuXG4gVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW4gYWxsXG4gY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cblxuIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOIFRIRVxuIFNPRlRXQVJFLlxuXG4gVGhpcyBpcyBiYXNlZCBvbjpcbiAvY29yZG92YS1wbHVnaW4tbWV0ZW9yLXdlYmFwcC9ibG9iL21hc3Rlci9zcmMvYW5kcm9pZC9XZWJBcHBMb2NhbFNlcnZlci5qYXZhXG5cbiAqL1xuXG52YXIgTW9kdWxlID0gcmVxdWlyZSgnLi9tb2R1bGUuanMnKTtcbnZhciBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xudmFyIGpvaW4gPSBwYXRoLmpvaW47XG52YXIgc2hlbGwgPSByZXF1aXJlKCdzaGVsbGpzJyk7XG52YXIgZnMgPSByZXF1aXJlKCdmcycpO1xudmFyIHVybCA9IHJlcXVpcmUoJ3VybCcpO1xudmFyIExvZyA9IHJlcXVpcmUoJy4vYXV0b3VwZGF0ZS9sb2dnZXInKTtcblxudmFyIEFzc2V0QnVuZGxlID0gcmVxdWlyZSgnLi9hdXRvdXBkYXRlL2Fzc2V0QnVuZGxlJyk7XG52YXIgQXNzZXRCdW5kbGVNYW5hZ2VyID0gcmVxdWlyZSgnLi9hdXRvdXBkYXRlL2Fzc2V0QnVuZGxlTWFuYWdlcicpO1xuXG52YXIgd2luc3RvbiA9IHJlcXVpcmUoJ3dpbnN0b24nKTtcbnZhciBsb2cgPSBuZXcgd2luc3Rvbi5Mb2dnZXIoe1xuICAgIGxldmVsOiAnZGVidWcnLFxuICAgIHRyYW5zcG9ydHM6IFtcbiAgICAgICAgbmV3ICh3aW5zdG9uLnRyYW5zcG9ydHMuQ29uc29sZSkoKSxcbiAgICAgICAgbmV3ICh3aW5zdG9uLnRyYW5zcG9ydHMuRmlsZSkoeyBmaWxlbmFtZTogam9pbihfX2Rpcm5hbWUsICcuLicsICdhdXRvdXBkYXRlTW9kdWxlLmxvZycpIH0pXG4gICAgXVxufSk7XG5cbi8qKlxuICogUmVwcmVzZW50cyB0aGUgaG90IGNvZGUgcHVzaCBjbGllbnQuXG4gKiBVbmxpa2UgdGhlIGNvcmRvdmEgaW1wbGVtZW50YXRpb24gdGhpcyBkb2VzIG5vdCBoYXZlIGEgYnVpbHRpbiBIVFRQIHNlcnZlci5cbiAqXG4gKiBAY29uc3RydWN0b3JcbiAqL1xuZnVuY3Rpb24gSENQQ2xpZW50KGwsIGFwcCwgc2V0dGluZ3MsIHN5c3RlbUV2ZW50cykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB2YXIgYXV0b3VwZGF0ZU1vZHVsZSA9IG5ldyBNb2R1bGUoJ2F1dG91cGRhdGVNb2R1bGUnKTtcblxuICAgIHRoaXMuX2wgPSBuZXcgTG9nKCdIQ1BDbGllbnQnLCBsb2cpO1xuXG4gICAgc3lzdGVtRXZlbnRzLm9uKCdpbml0aWFsaXphdGlvbicsIHRoaXMuX2luaXQuYmluZCh0aGlzKSk7XG5cbiAgICB0aGlzLl9jb25maWcgPSB7XG4gICAgICAgIGFwcElkOiBudWxsLFxuICAgICAgICByb290VXJsU3RyaW5nOiBudWxsLFxuICAgICAgICBjb3Jkb3ZhQ29tcGF0aWJpbGl0eVZlcnNpb246IG51bGwsXG4gICAgICAgIGJsYWNrbGlzdGVkVmVyc2lvbnM6IFtdLFxuICAgICAgICBsYXN0RG93bmxvYWRlZFZlcnNpb246IG51bGxcbiAgICB9O1xuXG4gICAgdGhpcy5fY29uZmlnRmlsZSA9IGpvaW4oX19kaXJuYW1lLCAnLi4nLCAnYXV0b3VwZGF0ZU1vZHVsZS5qc29uJyk7XG4gICAgdGhpcy5fdmVyc2lvbnNEaXIgPSBqb2luKF9fZGlybmFtZSwgJy4uJywgJ3ZlcnNpb25zJyk7XG5cbiAgICB0aGlzLl9tb2R1bGUgPSBhdXRvdXBkYXRlTW9kdWxlO1xuXG4gICAgdGhpcy5fbW9kdWxlLm9uKCdjaGVja0ZvclVwZGF0ZXMnLCBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKSB7XG4gICAgICAgIHZhciByb290VXJsID0gc2VsZi5fY3VycmVudEFzc2V0QnVuZGxlLmdldFJvb3RVcmxTdHJpbmcoKTtcbiAgICAgICAgaWYgKHJvb3RVcmwgPT09IG51bGwpIHtcbiAgICAgICAgICAgIG1vZHVsZS5zZW5kKFxuICAgICAgICAgICAgICAgICdlcnJvcicsXG4gICAgICAgICAgICAgICAgJ2NoZWNrRm9yVXBkYXRlcyByZXF1aXJlcyBhIHJvb3RVUkwgdG8gYmUgY29uZmlndXJlZCdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBzZWxmLl9hc3NldEJ1bmRsZU1hbmFnZXIuY2hlY2tGb3JVcGRhdGVzKHVybC5yZXNvbHZlKHJvb3RVcmwsICdfX2NvcmRvdmEvJykpO1xuICAgICAgICBzZWxmLl9ldmVudCA9IG51bGw7XG4gICAgfSk7XG59XG5cbi8qKlxuICogUGVyZm9ybXMgaW5pdGlhbGl6YXRpb24uXG4gKlxuICogQHByaXZhdGVcbiAqL1xuSENQQ2xpZW50LnByb3RvdHlwZS5faW5pdCA9IGZ1bmN0aW9uIF9pbml0KCkge1xuICAgIHZhciBpbml0aWFsQXNzZXRCdW5kbGU7XG4gICAgdmFyIGxhc3REb3dubG9hZGVkVmVyc2lvbjtcblxuICAgIGlmICghZnMuZXhpc3RzU3luYyh0aGlzLl9jb25maWdGaWxlKSkge1xuICAgICAgICB0aGlzLl9zYXZlQ29uZmlnKCk7XG4gICAgICAgIHRoaXMuX2wubG9nKCdpbmZvJywgJ0NyZWF0ZWQgZW1wdHkgYXV0b3VwZGF0ZU1vZHVsZS5qc29uJyk7XG4gICAgfVxuXG4gICAgdGhpcy5fcmVhZENvbmZpZygpO1xuXG4gICAgdGhpcy5fbC5sb2coJ2RlYnVnJywgJ1JlYWRpbmcgaW5pdGlhbCB2ZXJzaW9uJyk7XG4gICAgaW5pdGlhbEFzc2V0QnVuZGxlID0gbmV3IEFzc2V0QnVuZGxlKFxuICAgICAgICB0aGlzLl9sLmdldFVud3JhcHBlZExvZ2dlcigpLFxuICAgICAgICBqb2luKF9fZGlybmFtZSwgJy4uJywgJ21ldGVvcicpXG4gICAgKTtcblxuICAgIC8vIElmIHRoZSBsYXN0IHNlZW4gaW5pdGlhbCB2ZXJzaW9uIGlzIGRpZmZlcmVudCBmcm9tIHRoZSBjdXJyZW50bHkgYnVuZGxlZFxuICAgIC8vIHZlcnNpb24sIHdlIGRlbGV0ZSB0aGUgdmVyc2lvbnMgZGlyZWN0b3J5IGFuZCB1bnNldCBsYXN0RG93bmxvYWRlZFZlcnNpb25cbiAgICAvLyBhbmQgYmxhY2tsaXN0ZWRWZXJzaW9uc1xuICAgIC8qXG4gICAgIGlmICghaW5pdGlhbEFzc2V0QnVuZGxlLmdldFZlcnNpb24oKS5lcXVhbHMoY29uZmlndXJhdGlvbi5nZXRMYXN0U2VlbkluaXRpYWxWZXJzaW9uKCkpKSAge1xuICAgICBMb2cuZChMT0dfVEFHLCBcIkRldGVjdGVkIG5ldyBidW5kbGVkIHZlcnNpb24sIHJlbW92aW5nIHZlcnNpb25zIGRpcmVjdG9yeSBpZiBpdCBleGlzdHNcIik7XG4gICAgIGlmICh2ZXJzaW9uc0RpcmVjdG9yeS5leGlzdHMoKSkge1xuICAgICBpZiAoIUlPVXRpbHMuZGVsZXRlUmVjdXJzaXZlbHkodmVyc2lvbnNEaXJlY3RvcnkpKSB7XG4gICAgIExvZy53KExPR19UQUcsIFwiQ291bGQgbm90IHJlbW92ZSB2ZXJzaW9ucyBkaXJlY3RvcnlcIik7XG4gICAgIH1cbiAgICAgfVxuICAgICBjb25maWd1cmF0aW9uLnJlc2V0KCk7XG4gICAgIH0qL1xuXG4gICAgLy8gV2Uga2VlcCB0cmFjayBvZiB0aGUgbGFzdCBzZWVuIGluaXRpYWwgdmVyc2lvbiAoc2VlIGFib3ZlKVxuICAgIHRoaXMuX2NvbmZpZy5sYXN0U2VlbkluaXRpYWxWZXJzaW9uID0gaW5pdGlhbEFzc2V0QnVuZGxlLmdldFZlcnNpb24oKTtcblxuICAgIC8vIElmIHRoZSB2ZXJzaW9ucyBkaXJlY3RvcnkgZG9lcyBub3QgZXhpc3QsIHdlIGNyZWF0ZSBpdFxuICAgIGlmICghZnMuZXhpc3RzU3luYyh0aGlzLl92ZXJzaW9uc0RpcikpIHtcbiAgICAgICAgdGhpcy5fbC5sb2coJ2luZm8nLCAnQ3JlYXRlZCB2ZXJzaW9ucyBkaXIuJyk7XG4gICAgICAgIC8vIFRPRE86IHRyeS9jYXRjaFxuICAgICAgICBzaGVsbC5ta2Rpcih0aGlzLl92ZXJzaW9uc0Rpcik7XG4gICAgfVxuXG4gICAgdGhpcy5fYXNzZXRCdW5kbGVNYW5hZ2VyID0gbmV3IEFzc2V0QnVuZGxlTWFuYWdlcihcbiAgICAgICAgdGhpcy5fbC5nZXRVbndyYXBwZWRMb2dnZXIoKSxcbiAgICAgICAgdGhpcy5fY29uZmlnLFxuICAgICAgICBpbml0aWFsQXNzZXRCdW5kbGUsXG4gICAgICAgIHRoaXMuX3ZlcnNpb25zRGlyXG4gICAgKTtcblxuICAgIHRoaXMuX2Fzc2V0QnVuZGxlTWFuYWdlci5zZXRDYWxsYmFjayh0aGlzKTtcblxuICAgIGxhc3REb3dubG9hZGVkVmVyc2lvbiA9IHRoaXMuX2NvbmZpZy5sYXN0RG93bmxvYWRlZFZlcnNpb247XG4gICAgaWYgKGxhc3REb3dubG9hZGVkVmVyc2lvbikge1xuICAgICAgICB0aGlzLl9jdXJyZW50QXNzZXRCdW5kbGUgPSB0aGlzLl9hc3NldEJ1bmRsZU1hbmFnZXJcbiAgICAgICAgICAgIC5fZG93bmxvYWRlZEFzc2V0QnVuZGxlc0J5VmVyc2lvbltsYXN0RG93bmxvYWRlZFZlcnNpb25dO1xuXG4gICAgICAgIGlmICh0aGlzLl9jdXJyZW50QXNzZXRCdW5kbGUgPT09IG51bGwpIHtcbiAgICAgICAgICAgIHRoaXMuX2N1cnJlbnRBc3NldEJ1bmRsZSA9IGluaXRpYWxBc3NldEJ1bmRsZTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBc3NldEJ1bmRsZSA9IGluaXRpYWxBc3NldEJ1bmRsZTtcbiAgICB9XG5cbiAgICB0aGlzLl9jb25maWcuYXBwSWQgPSB0aGlzLl9jdXJyZW50QXNzZXRCdW5kbGUuZ2V0QXBwSWQoKTtcbiAgICB0aGlzLl9jb25maWcucm9vdFVybFN0cmluZyA9IHRoaXMuX2N1cnJlbnRBc3NldEJ1bmRsZS5nZXRSb290VXJsU3RyaW5nKCk7XG4gICAgdGhpcy5fY29uZmlnLmNvcmRvdmFDb21wYXRpYmlsaXR5VmVyc2lvbiA9IHRoaXMuX2N1cnJlbnRBc3NldEJ1bmRsZS5jb3Jkb3ZhQ29tcGF0aWJpbGl0eVZlcnNpb247XG5cbiAgICB0aGlzLl9zYXZlQ29uZmlnKCk7XG5cbiAgICB0aGlzLl9wZW5kaW5nQXNzZXRCdW5kbGUgPSBudWxsO1xufTtcblxuSENQQ2xpZW50LnByb3RvdHlwZS5nZXRQZW5kaW5nVmVyc2lvbiA9IGZ1bmN0aW9uIGdldFBlbmRpbmdWZXJzaW9uKCkge1xuICAgIGlmICh0aGlzLl9wZW5kaW5nQXNzZXRCdW5kbGUgIT09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3BlbmRpbmdBc3NldEJ1bmRsZS5nZXRWZXJzaW9uKCk7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIFJldHVybnMgdGhlIGN1cnJlbnQgYXNzZXRzIGJ1bmRsZSdzIGRpcmVjdG9yeS5cbiAqIEByZXR1cm5zIHtzdHJpbmd9XG4gKi9cbkhDUENsaWVudC5wcm90b3R5cGUuZ2V0RGlyZWN0b3J5ID0gZnVuY3Rpb24gZ2V0RGlyZWN0b3J5KCkge1xuICAgIHJldHVybiB0aGlzLl9jdXJyZW50QXNzZXRCdW5kbGUuZ2V0RGlyZWN0b3J5VXJpKCk7XG59O1xuXG4vKipcbiAqIFJldHVybnMgdGhlIHBhcmVudCBhc3NldCBidW5kbGUncyBkaXJlY3RvcnkuXG4gKiBAcmV0dXJucyB7c3RyaW5nfG51bGx9XG4gKi9cbkhDUENsaWVudC5wcm90b3R5cGUuZ2V0UGFyZW50RGlyZWN0b3J5ID0gZnVuY3Rpb24gZ2V0UGFyZW50RGlyZWN0b3J5KCkge1xuICAgIHJldHVybiB0aGlzLl9jdXJyZW50QXNzZXRCdW5kbGUuZ2V0UGFyZW50QXNzZXRCdW5kbGUoKSA/XG4gICAgICAgIHRoaXMuX2N1cnJlbnRBc3NldEJ1bmRsZS5nZXRQYXJlbnRBc3NldEJ1bmRsZSgpLmdldERpcmVjdG9yeVVyaSgpIDogbnVsbDtcbn07XG5cblxuLyoqXG4gKiBUaGlzIGlzIGZpcmVkIHdoZW4gYSBuZXcgdmVyc2lvbiBpcyByZWFkeSBhbmQgd2UgbmVlZCB0byByZXNldCAocmVsb2FkKSB0aGUgQnJvd3Nlci5cbiAqL1xuSENQQ2xpZW50LnByb3RvdHlwZS5vblJlc2V0ID0gZnVuY3Rpb24gb25SZXNldCgpIHtcbiAgICAvLyBJZiB0aGVyZSBpcyBhIHBlbmRpbmcgYXNzZXQgYnVuZGxlLCB3ZSBtYWtlIGl0IHRoZSBjdXJyZW50XG4gICAgaWYgKHRoaXMuX3BlbmRpbmdBc3NldEJ1bmRsZSAhPT0gbnVsbCkge1xuICAgICAgICB0aGlzLl9jdXJyZW50QXNzZXRCdW5kbGUgPSB0aGlzLl9wZW5kaW5nQXNzZXRCdW5kbGU7XG4gICAgICAgIHRoaXMuX3BlbmRpbmdBc3NldEJ1bmRsZSA9IG51bGw7XG4gICAgfVxuXG4gICAgdGhpcy5fbC5sb2coJ2luZm8nLCAnU2VydmluZyBhc3NldCBidW5kbGUgd2l0aCB2ZXJzaW9uOiAnXG4gICAgICAgICsgdGhpcy5fY3VycmVudEFzc2V0QnVuZGxlLmdldFZlcnNpb24oKSk7XG5cbiAgICB0aGlzLl9jb25maWcuYXBwSWQgPSB0aGlzLl9jdXJyZW50QXNzZXRCdW5kbGUuZ2V0QXBwSWQoKTtcbiAgICB0aGlzLl9jb25maWcucm9vdFVybFN0cmluZyA9IHRoaXMuX2N1cnJlbnRBc3NldEJ1bmRsZS5nZXRSb290VXJsU3RyaW5nKCk7XG4gICAgdGhpcy5fY29uZmlnLmNvcmRvdmFDb21wYXRpYmlsaXR5VmVyc2lvbiA9IHRoaXMuX2N1cnJlbnRBc3NldEJ1bmRsZS5jb3Jkb3ZhQ29tcGF0aWJpbGl0eVZlcnNpb247XG5cbiAgICB0aGlzLl9zYXZlQ29uZmlnKCk7XG5cbiAgICAvLyBEb24ndCBzdGFydCBzdGFydHVwIHRpbWVyIHdoZW4gcnVubmluZyBhIHRlc3RcbiAgICAvLyBpZiAodGVzdGluZ0RlbGVnYXRlID09IG51bGwpIHtcbiAgICAvLyAgc3RhcnRTdGFydHVwVGltZXIoKTtcbiAgICAvLyB9XG59O1xuXG4vKipcbiAqIFNhdmUgdGhlIGN1cnJlbnQgY29uZmlnLlxuICogQHByaXZhdGVcbiAqL1xuSENQQ2xpZW50LnByb3RvdHlwZS5fc2F2ZUNvbmZpZyA9IGZ1bmN0aW9uIF9zYXZlQ29uZmlnKCkge1xuICAgIGZzLndyaXRlRmlsZVN5bmModGhpcy5fY29uZmlnRmlsZSwgSlNPTi5zdHJpbmdpZnkodGhpcy5fY29uZmlnLCBudWxsLCAnXFx0JykpO1xufTtcblxuLyoqXG4gKiBSZWFkcyBjb25maWcganNvbiBmaWxlLlxuICogQHByaXZhdGVcbiAqL1xuSENQQ2xpZW50LnByb3RvdHlwZS5fcmVhZENvbmZpZyA9IGZ1bmN0aW9uIF9yZWFkQ29uZmlnKCkge1xuICAgIC8vIFRPRE86IHRyeS9jYXRjaFxuICAgIHRoaXMuX2NvbmZpZyA9IEpTT04ucGFyc2UoZnMucmVhZEZpbGVTeW5jKHRoaXMuX2NvbmZpZ0ZpbGUsICdVVEYtOCcpKTtcbn07XG5cbi8qKlxuICogRXJyb3IgY2FsbGJhY2sgZmlyZWQgYnkgYXNzZXRCdW5kbGVNYW5hZ2VyLlxuICogQHBhcmFtIGNhdXNlXG4gKi9cbkhDUENsaWVudC5wcm90b3R5cGUub25FcnJvciA9IGZ1bmN0aW9uIG9uRXJyb3IoY2F1c2UpIHtcbiAgICB0aGlzLl9sLmxvZygnZXJyb3InLCAnRG93bmxvYWQgZmFpbHVyZTogJyArIGNhdXNlKTtcbiAgICB0aGlzLl9ub3RpZnlFcnJvcihjYXVzZSk7XG59O1xuXG4vKipcbiAqIEZpcmVzIGVycm9yIGNhbGxiYWNrIGZyb20gdGhlIG1ldGVvcidzIHNpZGUuXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IGNhdXNlIC0gRXJyb3IgbWVzc2FnZS5cbiAqIEBwcml2YXRlXG4gKi9cbkhDUENsaWVudC5wcm90b3R5cGUuX25vdGlmeUVycm9yID0gZnVuY3Rpb24gX25vdGlmeUVycm9yKGNhdXNlKSB7XG4gICAgdGhpcy5fbC5sb2coJ2Vycm9yJywgJ0Rvd25sb2FkIGZhaWx1cmU6ICcgKyBjYXVzZSk7XG4gICAgdGhpcy5fbW9kdWxlLnNlbmQoXG4gICAgICAgICdlcnJvcicsXG4gICAgICAgICdbYXV0b3VwZGF0ZV0gRG93bmxvYWQgZmFpbHVyZTogJyArIGNhdXNlXG4gICAgKTtcbn07XG5cbi8qKlxuICogTWFrZXMgZG93bmxvYWRlZCBhc3NldCBwZW5kaW5nLiBGaXJlZCBieSBhc3NldEJ1bmRsZU1hbmFnZXIuXG4gKiBAcGFyYW0gYXNzZXRCdW5kbGVcbiAqL1xuSENQQ2xpZW50LnByb3RvdHlwZS5vbkZpbmlzaGVkRG93bmxvYWRpbmdBc3NldEJ1bmRsZSA9XG4gICAgZnVuY3Rpb24gb25GaW5pc2hlZERvd25sb2FkaW5nQXNzZXRCdW5kbGUoYXNzZXRCdW5kbGUpIHtcbiAgICAgICAgdGhpcy5fY29uZmlnLmxhc3REb3dubG9hZGVkVmVyc2lvbiA9IGFzc2V0QnVuZGxlLmdldFZlcnNpb24oKTtcbiAgICAgICAgdGhpcy5fc2F2ZUNvbmZpZygpO1xuICAgICAgICB0aGlzLl9wZW5kaW5nQXNzZXRCdW5kbGUgPSBhc3NldEJ1bmRsZTtcbiAgICAgICAgdGhpcy5fbm90aWZ5TmV3VmVyc2lvblJlYWR5KGFzc2V0QnVuZGxlLmdldFZlcnNpb24oKSk7XG4gICAgfTtcblxuLyoqXG4gKiBOb3RpZnkgbWV0ZW9yIHRoYXQgYSBuZXcgdmVyc2lvbiBpcyByZWFkeS5cbiAqIEBwYXJhbSB7c3RyaW5nfSB2ZXJzaW9uIC0gVmVyc2lvbiBzdHJpbmcuXG4gKiBAcHJpdmF0ZVxuICovXG5IQ1BDbGllbnQucHJvdG90eXBlLl9ub3RpZnlOZXdWZXJzaW9uUmVhZHkgPSBmdW5jdGlvbiBfbm90aWZ5TmV3VmVyc2lvblJlYWR5KHZlcnNpb24pIHtcbiAgICB0aGlzLl9tb2R1bGUuc2VuZChcbiAgICAgICAgJ29uTmV3VmVyc2lvblJlYWR5JyxcbiAgICAgICAgdmVyc2lvblxuICAgICk7XG59O1xuXG4vKipcbiAqIE1ldGhvZCB0aGF0IGRlY2lkZXMgd2hldGhlciB3ZSBhcmUgaW50ZXJlc3RlZCBpbiB0aGUgbmV3IGJ1bmRsZSB0aGF0IHdlIHdlcmUgbm90aWZpZWQgYWJvdXQuXG4gKlxuICogQHBhcmFtIHtBc3NldE1hbmlmZXN0fSBtYW5pZmVzdCAtIE1hbmlmZXN0IG9mIHRoZSBuZXcgYnVuZGxlLlxuICogQHJldHVybnMge2Jvb2xlYW59XG4gKi9cbkhDUENsaWVudC5wcm90b3R5cGUuc2hvdWxkRG93bmxvYWRCdW5kbGVGb3JNYW5pZmVzdCA9XG4gICAgZnVuY3Rpb24gc2hvdWxkRG93bmxvYWRCdW5kbGVGb3JNYW5pZmVzdChtYW5pZmVzdCkge1xuICAgICAgICB2YXIgdmVyc2lvbiA9IG1hbmlmZXN0LnZlcnNpb247XG5cbiAgICAgICAgLy8gTm8gbmVlZCB0byByZWRvd25sb2FkIHRoZSBjdXJyZW50IHZlcnNpb25cbiAgICAgICAgaWYgKHRoaXMuX2N1cnJlbnRBc3NldEJ1bmRsZS5nZXRWZXJzaW9uKCkgPT09IHZlcnNpb24pIHtcbiAgICAgICAgICAgIHRoaXMuX2wubG9nKCdpbmZvJywgJ1NraXBwaW5nIGRvd25sb2FkaW5nIGN1cnJlbnQgdmVyc2lvbjogJyArIHZlcnNpb24pO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gTm8gbmVlZCB0byByZWRvd25sb2FkIHRoZSBwZW5kaW5nIHZlcnNpb25cbiAgICAgICAgaWYgKHRoaXMuX3BlbmRpbmdBc3NldEJ1bmRsZSAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgdGhpcy5fcGVuZGluZ0Fzc2V0QnVuZGxlLmdldFZlcnNpb24oKSA9PT0gdmVyc2lvbikge1xuICAgICAgICAgICAgdGhpcy5fbC5sb2coJ2luZm8nLCAnU2tpcHBpbmcgZG93bmxvYWRpbmcgcGVuZGluZyB2ZXJzaW9uOiAnICsgdmVyc2lvbik7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBEb24ndCBkb3dubG9hZCBibGFja2xpc3RlZCB2ZXJzaW9uc1xuICAgICAgICBpZiAofnRoaXMuX2NvbmZpZy5ibGFja2xpc3RlZFZlcnNpb25zLmluZGV4T2YodmVyc2lvbikpIHtcbiAgICAgICAgICAgIHRoaXMuX25vdGlmeUVycm9yKCdTa2lwcGluZyBkb3dubG9hZGluZyBibGFja2xpc3RlZCB2ZXJzaW9uOiAnICsgdmVyc2lvbik7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBUT0RPOiBwbGFjZSBmb3IgY2hlY2tpbmcgZWxlY3Ryb24gY29tcGF0aWJpbGl0eSB2ZXJzaW9uXG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfTtcblxubW9kdWxlLmV4cG9ydHMgPSBIQ1BDbGllbnQ7XG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=