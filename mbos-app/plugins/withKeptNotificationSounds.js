const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

/**
 * Keeps the notification sounds in the APK that resource shrinking removes.
 *
 * `withLeanAndroid` turns on `shrinkResources`, which deletes every resource
 * nothing references in code. The expo-notifications plugin copies
 * `mbos_alert.wav` and `mbos_update.wav` into `res/raw` — and nothing in code
 * references them, because a notification CHANNEL names its sound as a
 * string at runtime. So the first 1.16.0 build shipped without either file:
 * the channels would have been created pointing at sounds that were not
 * there, and an Android channel's sound can never be changed afterwards.
 * Found by unzipping the build, not by any check that would have failed.
 *
 * A `tools:keep` resource is Android's own answer. The list is READ from the
 * expo-notifications entry in app.json rather than written out here, so a
 * third sound added there is kept without anybody remembering this file.
 */
function notificationSounds(config) {
  for (const p of config.plugins ?? []) {
    if (Array.isArray(p) && p[0] === 'expo-notifications') {
      return (p[1]?.sounds ?? []).map((f) => path.basename(f).replace(/\.[^.]+$/, ''));
    }
  }
  return [];
}

module.exports = function withKeptNotificationSounds(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const names = notificationSounds(config);
      if (!names.length) return config;
      const dir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'raw');
      fs.mkdirSync(dir, { recursive: true });
      const keep = names.map((n) => `@raw/${n}`).join(',');
      fs.writeFileSync(
        path.join(dir, 'mbos_keep_sounds.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="${keep}" />\n`,
      );
      return config;
    },
  ]);
};
