const expo = require('eslint-config-expo/flat');

module.exports = [
  ...expo,
  { ignores: ['node_modules/**', '.expo/**', 'dist/**'] },
  /*
   * THREE REACT COMPILER RULES ARRIVED WITH SDK 57's eslint-config-expo, and
   * they are off here on purpose, for now.
   *
   * SDK 54's config did not carry them, so the code was never held to them:
   * turning them on in the same change as the SDK upgrade put fifty findings
   * (29 refs, 19 set-state-in-effect, 2 purity) in front of a change whose job
   * is to move the platform, not to rewrite fifty effects. None is a new
   * fault — the React Compiler is not enabled in this app (no
   * `experiments.reactCompiler` in app.json), so they flag code it would
   * decline to optimise, not code that now behaves differently.
   *
   * They belong on. Switching them on is a change of its own, made one finding
   * at a time and tried on a handset. Delete this block then.
   */
  {
    rules: {
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },
];
