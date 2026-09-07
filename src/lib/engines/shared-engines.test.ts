import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SHARED_ENGINES,
  expected,
  generatedPath,
} from "../../../scripts/sync-mbos-engines.mjs";

/* ---------------------------------------------------------------------------
 * The handset's copy is current.
 *
 * This is the whole enforcement of §1.3 of the plan. The expense engine runs
 * on the phone and on the server, and a salesman told ₹450 who is paid ₹250
 * with nothing on any screen explaining the difference stops trusting the app —
 * so the two copies are not allowed to be two.
 *
 * If this fails, run `npm run mbos:sync-engines`. It is not a flaky test: it
 * is somebody having edited the source without carrying it across.
 * ------------------------------------------------------------------------- */

describe("the engines shared with MBOS", () => {
  for (const name of SHARED_ENGINES) {
    test(`${name} is copied to the handset byte for byte`, () => {
      let onDisk: string;
      try {
        onDisk = readFileSync(generatedPath(name), "utf8");
      } catch {
        assert.fail(
          `mbos-app has no copy of ${name}. Run \`npm run mbos:sync-engines\`.`,
        );
      }
      assert.equal(
        onDisk,
        expected(name),
        `The handset's copy of ${name} is stale. Run \`npm run mbos:sync-engines\`.`,
      );
    });
  }

  test("a shared engine imports nothing", () => {
    /* The handset has no `@/lib`, no `server-only`, no database and no
       Next.js. An engine that reaches for any of them cannot be shared, and
       the failure would otherwise be a red Metro screen on somebody's phone
       rather than a red test here. */
    for (const name of SHARED_ENGINES) {
      const source = readFileSync(`src/lib/engines/${name}`, "utf8");
      const imports = source.match(/^\s*import\s+[^;]+;/gm) ?? [];
      const valueImports = imports.filter((i) => !/^\s*import\s+type\b/.test(i));
      assert.deepEqual(
        valueImports,
        [],
        `${name} is shared with the handset, so it may not import anything.`,
      );
    }
  });
});
