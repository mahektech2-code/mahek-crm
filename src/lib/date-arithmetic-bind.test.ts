import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * A NUMBER SUBTRACTED FROM A DATE NEEDS ITS TYPE SAID OUT LOUD.
 *
 * `${day}::date - ${days}` binds `days` as a parameter with no type, and
 * Postgres is free to resolve the subtraction as `date - date` — which yields
 * an integer, so the comparison beside it becomes `date >= integer` and the
 * whole query throws with "operator does not exist". It type-checks, it
 * lints, and it fails only at the database. It took the MBOS pull delta down
 * once (`planDaysFor`) and the Leads page down once (`lost30`), and both
 * times every OTHER spelling in the tree already carried the cast, which is
 * exactly why nobody noticed the one that did not.
 *
 * So the cast is a rule about the SOURCE, read here the way the zone guards
 * read for a bare `::date`: every `::date` followed by `+` or `-` and a bind
 * parameter has to carry `::int` on the parameter.
 * ------------------------------------------------------------------------- */

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(path) && !path.endsWith(".test.ts") ? [path] : [];
  });
}

test("a bind parameter added to or subtracted from a date carries ::int", () => {
  const faults: string[] = [];
  for (const file of files("src")) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      /* `::date - ${x}` or `::date + ${x}` where the interpolation is not
         followed by `::int`. `${x}::int` is the spelling every other site
         uses; an interval literal or a plain number is not a bind and is not
         matched. */
      const re = /::date\s*[-+]\s*\$\{[^}]*\}(?!::int)/g;
      if (re.test(line)) faults.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    faults,
    [],
    "Postgres may read an untyped parameter beside a date as a date, and the " +
      "subtraction then yields an integer nothing can compare to:\n  " +
      faults.join("\n  "),
  );
});

test("the guard recognises both spellings", () => {
  const re = /::date\s*[-+]\s*\$\{[^}]*\}(?!::int)/;
  assert.ok(re.test("c.since >= ${day}::date - ${LOST_WINDOW_DAYS}`"));
  assert.ok(re.test("(now() at time zone ${APP_TIMEZONE})::date - ${PLAN_HISTORY_DAYS}"));
  assert.ok(!re.test("c.since >= ${day}::date - ${LOST_WINDOW_DAYS}::int`"));
  assert.ok(!re.test("and (${onDate}::date + ${windowDays}::int)"));
});
