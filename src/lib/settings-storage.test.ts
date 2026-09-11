import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { SETTINGS } from "@/lib/config/registry";

/**
 * WHAT A SETTING'S DEFAULT MAY BE, given the column it has to land in.
 *
 * `app_settings.value` is `jsonb NOT NULL`. A setting whose default is
 * legitimately null — `mbos.attendance.baseLocation`, which is no office
 * picked yet — hands Drizzle a JS `null`, which is SQL NULL, not JSON null,
 * and violates the column.
 *
 * It is worth a test of its own because of HOW it fails. `seedConfig` inserts
 * every setting in ONE statement, so a single null-defaulted key fails the
 * batch, every test that needs configuration dies at the same line, and the
 * message names the insert rather than the key. It took all 293 integration
 * tests down and not one unit test: the engine suite never opens a database.
 * The `as never` on each write is why the type checker said nothing either.
 *
 * So this asserts the two halves that keep it safe — a null default is
 * declared as one, and the write path turns it into JSON null rather than SQL
 * NULL. The second is read out of the source because `store.ts` is
 * `server-only` and cannot be imported into a unit test; that is a weaker
 * check than calling it, and still enough to fail if somebody puts the bare
 * cast back.
 */

test("a setting that defaults to null says so", () => {
  const wrong = SETTINGS.filter(
    (s) => s.default === null && !(s as { nullable?: boolean }).nullable,
  ).map((s) => s.key);

  assert.deepEqual(
    wrong,
    [],
    "these default to null without being marked nullable, so nothing validates " +
      "them as nullable and nothing warns that the column will refuse them: " +
      wrong.join(", "),
  );
});

test("every writer of app_settings.value goes through the one helper", () => {
  /* FOUND BY MISSING ONE. The first fix covered the five writes in `store.ts`
     and not the sixth in `db/seed.ts`, so the integration suite went green
     while the link crawl stayed red on the identical error — one seeds through
     the store, the other seeds through itself. A test naming one file could
     only ever have caught the half somebody had already thought of, so this
     one finds the writers instead of being told where they are. */
  const writers = readdirSyncDeep("src")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
    .filter((f) => readFileSync(f, "utf8").includes("insert(appSettings)"));

  assert.ok(
    writers.length >= 2,
    "no writers of app_settings found — the scan is broken, not the code",
  );

  const bare: string[] = [];
  for (const file of writers) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("storedSettingValue")) {
      bare.push(`${file} — writes app_settings without storedSettingValue()`);
    }
    for (const m of text.matchAll(/value:\s*([A-Za-z0-9_.]+)\s+as never/g)) {
      bare.push(`${file} — \`value: ${m[1]} as never\`, the cast that hid a JS null from the type checker`);
    }
  }

  assert.deepEqual(
    bare,
    [],
    "app_settings.value is jsonb NOT NULL, and a null-defaulted setting written " +
      "this way fails the whole batch insert:\n" + bare.join("\n"),
  );
});

function readdirSyncDeep(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) readdirSyncDeep(path, out);
    else out.push(path);
  }
  return out;
}
