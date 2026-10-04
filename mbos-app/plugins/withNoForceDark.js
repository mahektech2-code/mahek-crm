const { withAndroidStyles, AndroidConfig } = require('expo/config-plugins');

/**
 * KEEPS THE PHONE FROM INVERTING THIS APP'S COLOURS ON ITS OWN.
 *
 * `app.json` says `userInterfaceStyle: light`: there is one palette, drawn for
 * daylight in a shop, and nothing in it has a dark counterpart. MIUI, ColorOS,
 * Funtouch and One UI all offer a system switch — "dark mode for apps", "force
 * dark" — that ignores that and recolours any app whose theme does not refuse,
 * by guessing. The guess turns the amber "behind" pills and the red refusals
 * into muddy shades of grey on near-black, which is the one place in the app
 * where colour is carrying the meaning.
 *
 * `android:forceDarkAllowed="false"` on the app theme is the refusal, and the
 * theme is regenerated on every `expo prebuild` — `android/` is not committed
 * — so it has to be set here rather than in a file somebody edits once.
 * No `targetApi`: that needs the `tools` namespace on the generated file, and
 * the attribute is simply ignored below Android 10, which is the same answer.
 */
module.exports = function withNoForceDark(config) {
  return withAndroidStyles(config, (cfg) => {
    cfg.modResults = AndroidConfig.Styles.assignStylesValue(cfg.modResults, {
      add: true,
      parent: AndroidConfig.Styles.getAppThemeGroup(),
      name: 'android:forceDarkAllowed',
      value: 'false',
    });
    return cfg;
  });
};
