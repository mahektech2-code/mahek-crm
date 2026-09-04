const fs = require('fs');
const path = require('path');
const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Makes every release build reach for the SAME keystore, forever.
 *
 * `android/` is gitignored and rebuilt from scratch by `expo prebuild` every
 * time, so a signing config edited by hand in the generated build.gradle
 * would be erased the next time somebody ran prebuild. This plugin is what
 * survives that: it runs as part of prebuild itself and re-applies the
 * signing config to whatever build.gradle was just generated.
 *
 * The keystore lives at mbos-app/keystore/ — OUTSIDE the gitignored
 * `android/` directory, and committed — so it is the one constant across
 * every rebuild, on any machine. Without this, the release buildType falls
 * back to `signingConfigs.debug`, which react-native's own template ships a
 * fixed `debug.keystore` for — usually stable across a fresh prebuild, but
 * never a promise, and exactly the kind of "usually" that turns into
 * everyone on the field team needing to reinstall the app the day it stops
 * being reused.
 */
module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withReleaseSigning only supports Groovy build.gradle files');
    }

    const propsPath = path.join(__dirname, '..', 'keystore', 'mbos-release.keystore.properties');
    if (!fs.existsSync(propsPath)) {
      throw new Error(
        `withReleaseSigning: ${propsPath} is missing. It is gitignored on purpose — ` +
          'see keystore/README.md for where the password lives and why.',
      );
    }
    const raw = fs.readFileSync(propsPath, 'utf8');
    const get = (key) => {
      const match = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (!match) throw new Error(`withReleaseSigning: ${key} missing from ${propsPath}`);
      return match[1].trim();
    };
    const storePassword = get('storePassword');
    const keyPassword = get('keyPassword');
    const keyAlias = get('keyAlias');

    let contents = config.modResults.contents;

    // The generated file always has exactly this debug-only signingConfigs
    // block (react-native's own template) — closing brace included, so the
    // release block below lands inside signingConfigs {} rather than needing
    // its own separate insertion point.
    const anchor = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;
    if (!contents.includes(anchor)) {
      throw new Error(
        'withReleaseSigning: the debug signingConfigs block has changed shape — ' +
          'update the anchor string in plugins/withReleaseSigning.js to match.',
      );
    }
    const releaseSigningConfig = `        release {
            storeFile file('../../keystore/mbos-release.keystore')
            storePassword '${storePassword}'
            keyAlias '${keyAlias}'
            keyPassword '${keyPassword}'
        }
    }`;
    contents = contents.replace(anchor, `${anchor.slice(0, -6)}\n${releaseSigningConfig}`);

    // The release buildType reuses signingConfigs.debug by default — point it
    // at the release one instead, exactly once, leaving the debug buildType's
    // own use of signingConfigs.debug untouched.
    contents = contents.replace(
      /(release\s*\{\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*)signingConfig signingConfigs\.debug/,
      '$1signingConfig signingConfigs.release',
    );
    if (!contents.includes('signingConfig signingConfigs.release')) {
      throw new Error(
        'withReleaseSigning: could not repoint the release buildType — ' +
          'update the pattern in plugins/withReleaseSigning.js to match the current template.',
      );
    }

    config.modResults.contents = contents;
    return config;
  });
};
