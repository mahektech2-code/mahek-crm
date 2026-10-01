const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

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
 * IF A 32-BIT PHONE JOINS THE TEAM — some cheap "Android Go" handsets run a
 * 32-bit Android on a 64-bit chip — do not put `armeabi-v7a` back into this one
 * APK. Build a second APK for it, so nobody else downloads its code.
 */
const GRADLE_PROPERTIES = {
  // 64-bit ARM only. See above.
  reactNativeArchitectures: 'arm64-v8a',
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

module.exports = function withLeanAndroid(config) {
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
}
`;
    }
    return config;
  });
};
