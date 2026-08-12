import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    /*
     * The field app is React Native and lints itself.
     *
     * It has its own `eslint.config.js` and its own `lint` script, and under
     * those it is clean. What was happening is that the root run — this file,
     * which is `eslint-config-next` — reached into it and produced 23 errors
     * about refs during render and `require()` imports, which are rules for a
     * Next.js app and not for an Expo one.
     *
     * That made `npm run lint` fail on every commit since the field app
     * landed, which made CI red on every commit since, which meant no commit
     * got a lint signal at all. A check that is always failing is a check
     * nobody reads.
     *
     * Ignored here rather than fixed there, because there was nothing wrong
     * there. CI runs the field app's own lint as its own step, so it is not
     * left unchecked by being taken out of this one.
     */
    "mbos-app/**",
  ]),
]);

export default eslintConfig;
