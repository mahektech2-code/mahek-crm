import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("nothing writes a bare default into the value column any more", () => {
  const store = readFileSync("src/lib/config/store.ts", "utf8");

  assert.ok(
    /function stored\(/.test(store),
    "`stored()` has gone — it is what turns a null default into JSON null " +
      "rather than SQL NULL, and app_settings.value is NOT NULL",
  );
  assert.ok(
    store.includes("sql`'null'::jsonb`"),
    "`stored()` no longer writes JSON null, so a null-defaulted setting will " +
      "fail the seed insert and take every integration test with it",
  );

  /* The exact shape that caused it, in any of the five write sites. */
  for (const bare of [
    "value: s.default as never",
    "value: validated.value as never",
    "value: value as never",
  ]) {
    assert.ok(
      !store.includes(bare),
      `\`${bare}\` is back — that cast is what hid a JS null on its way to a ` +
        "NOT NULL column from the type checker",
    );
  }
});
