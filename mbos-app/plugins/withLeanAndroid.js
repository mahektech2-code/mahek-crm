const fs = require('fs');
const path = require('path');
const { withAppBuildGradle, withDangerousMod, withGradleProperties } = require('expo/config-plugins');

/**
 * Keeps the release APK the size of what a phone in the field actually runs.
 *
 * The APK was 164 MB, and 102 MB of it was native code for processors no
 * salesman's phone has: x86 and x86_64 (emulators and Chromebooks) and 32-bit
 * ARM. Every handset in `mbos_devices` is 64-bit ARM. On top of that the dex
 * was never shrunk, the native libraries were stored uncompressed, and three
 * unused libraries plus Google's ML Kit barcode engine rode along. Sideloaded
 * over mobile data, that is a download people put off — which is how a phone
 * ends up three releases behind.
 *
 * A plugin rather than an edit to the generated project, for the reason
 * `withReleaseSigning.js` gives: `android/` is rebuilt by `expo prebuild` on
 * every release, so anything set by hand there is gone the next time.
 *
 * A 32-BIT PHONE GETS AN APK OF ITS OWN, never a share of this one. Cheap
 * "Android Go" handsets run a 32-bit Android, often on a 64-bit chip, and the
 * 64-bit APK told them "App not installed" — which is how some of the field
 * could not install MBOS at all. So one build now makes TWO APKs through
 * Gradle's ABI split: `app-arm64-v8a-release.apk`, published as `mbos.apk`
 * exactly as before, and `app-armeabi-v7a-release.apk`, published as
 * `mbos-32bit.apk`. Neither carries the other's native code, so nobody
 * downloads more than his phone runs. Both have the same versionCode — a phone
 * only ever holds one of them, and the update check
 * (`engines/app-update.ts`) hands each phone the file its processor runs.
 *
 * Android older than 7.0 (API 24) cannot be helped here: that is React
 * Native's own floor, not a setting of ours.
 */
const GRADLE_PROPERTIES = {
  // 64-bit and 32-bit ARM, each in its own APK — see above. No x86.
  reactNativeArchitectures: 'arm64-v8a,armeabi-v7a',
  // R8: removes unused Java/Kotlin code, and the resources nothing references.
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
  /* Native libraries compressed inside the APK. Measured: the 64-bit
     libraries go from 28 MB to under 10 MB. Android unpacks them at install,
     so the installed app is somewhat larger than the download — the right way
     round for an app downloaded over mobile data. */
  'expo.useLegacyPackaging': 'true',
  /* The image decoders for GIF and WebP. Nothing in MBOS shows a GIF, and
     Android decodes plain WebP itself; 0.8 MB of native code for neither. */
  'expo.gif.enabled': 'false',
  'expo.webp.enabled': 'false',
};

/* ML Kit's barcode engine, which expo-camera depends on whether or not
   anything scans. MBOS never scans a barcode: expo-camera only starts the
   analyser when `barcodeScannerSettings` is passed, and no screen passes it.
   The Java classes stay, so nothing fails to load; only the 4.8 MB native
   engine that would run a scan is left out. If a screen ever starts scanning
   barcodes, remove this exclusion in the same change. */
const EXCLUDED_NATIVE_LIBS = ['**/libbarhopper_v3.so'];

const MARKER = '// withLeanAndroid: native libraries left out of the APK';

/*
 * WHAT R8 CANNOT SEE, IT DELETES — and one class here is only ever named in
 * a string.
 *
 * expo-task-manager runs a background task by asking `AppLoaderProvider` for
 * the "react-native-headless" loader, which reads the class NAME out of the
 * manifest (`org.unimodules.core.AppLoader#react-native-headless`) and calls
 * `Class.forName` on it. Nothing in the code refers to that class, so the
 * first shrunk build removed it, the lookup came back null, and every
 * background location batch Android delivered crashed the app with a
 * NullPointerException in `TaskService.executeTask` — on 1.15.0 (21), seen on
 * a Pixel 9a the day after the lean APK shipped. The trail is the thing that
 * dies: the office sees a salesman's day stop with nothing on the phone
 * saying why.
 *
 * Kept by package AND by interface, so a loader that moves or is renamed in a
 * later SDK is still kept.
 */
const PROGUARD_MARKER = '# withLeanAndroid: classes loaded by name';
const PROGUARD_RULES = `
${PROGUARD_MARKER}
-keep class expo.modules.adapters.react.apploader.** { *; }
-keep class * implements expo.modules.apploader.HeadlessAppLoader { <init>(); }
`;

module.exports = function withLeanAndroid(config) {
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const rules = path.join(config.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
      const existing = fs.existsSync(rules) ? fs.readFileSync(rules, 'utf8') : '';
      if (!existing.includes(PROGUARD_MARKER)) fs.writeFileSync(rules, existing + PROGUARD_RULES);
      return config;
    },
  ]);

  config = withGradleProperties(config, (config) => {
    for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) {
      const existing = config.modResults.find((item) => item.type === 'property' && item.key === key);
      if (existing) existing.value = value;
      else config.modResults.push({ type: 'property', key, value });
    }
    return config;
  });

  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withLeanAndroid only supports Groovy build.gradle files');
    }
    if (!config.modResults.contents.includes(MARKER)) {
      const excludes = EXCLUDED_NATIVE_LIBS.map((p) => `'${p}'`).join(', ');
      config.modResults.contents += `
${MARKER}
android {
    packagingOptions {
        jniLibs {
            excludes += [${excludes}]
        }
    }
    // One APK per processor: the 64-bit one stays mbos.apk, the 32-bit one is
    // mbos-32bit.apk. No universal APK, so neither carries the other's code.
    splits {
        abi {
            enable true
            reset()
            include 'arm64-v8a', 'armeabi-v7a'
            universalApk false
        }
    }
}
`;
    }
    return config;
  });
};
