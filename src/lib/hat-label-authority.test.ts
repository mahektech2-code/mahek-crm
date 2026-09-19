import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEVEL_LABELS } from "./hat-labels";

/* ---------------------------------------------------------------------------
 * A LABEL IS NOT AN AUTHORITY.
 *
 * `hat-labels.ts` turns a level into the word a header prints — "Admin",
 * "Manager", "Associate" — and it says in its own header that it exists to be
 * reworded. The Admin Console then took that label as its `me.role` and
 * decided one thing from it:
 *
 *     isAdmin={me.role === "admin"}
 *
 * which has been `"Admin" === "admin"` since the day roles became levels.
 * False for everybody, for ever, with nothing failing: the one item it guards
 * is "Login as …" in the People row menu, so the whole impersonation
 * feature — its token table, its action, its audit row, its confirmation
 * screen, all of it working — simply stopped having a door. Nobody could
 * report it as broken, because there was nothing on the screen to press.
 *
 * The comparison is the bug, not the capitalisation: a label that matched by
 * luck would still be a permission decided by a sentence somebody may edit.
 * So this fails on either shape — a label compared to a stored role value,
 * and a stored role value compared to a label.
 * ------------------------------------------------------------------------- */

const STORED = ["admin", "manager", "associate", "accounts", "telecaller"];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("nothing decides anything from a hat label", () => {
  const offenders: string[] = [];
  for (const file of tsFiles("src")) {
    if (file.endsWith("hat-label-authority.test.ts")) continue;
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      /*
       * Prose is skipped, and a BLOCK comment's continuation line is prose
       * too — this codebase explains its rules at length beside them, so a
       * paragraph quoting the banned spelling is the ordinary case rather
       * than the exception. A guard that trips on its own explanation is one
       * somebody deletes.
       */
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return;
      const code = line.split("//")[0];
      // A label compared to a stored value: `me.role === "admin"`, where the
      // field is the console's display `role` rather than a `users` row.
      for (const stored of STORED) {
        if (
          new RegExp(`\\bme\\.role\\s*[=!]==?\\s*["']${stored}["']`).test(code) ||
          new RegExp(`\\bhat\\.label\\s*[=!]==?`).test(code)
        ) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      }
      // And the mirror: a stored role compared to a printed label.
      for (const label of Object.values(LEVEL_LABELS)) {
        if (new RegExp(`\\.role\\s*[=!]==?\\s*["']${label}["']`).test(code)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "read the level off the account and pass it as a boolean; a label is display",
  );
});

test("and the labels are not their own level values, so a match would be luck", () => {
  for (const [level, label] of Object.entries(LEVEL_LABELS)) {
    assert.notEqual(
      label,
      level,
      `"${label}" is the word printed for \`${level}\` — if the two are ever equal, a comparison against the wrong one starts passing by accident`,
    );
  }
});
