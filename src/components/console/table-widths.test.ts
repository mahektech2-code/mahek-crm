import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tableDeclarations } from "./table-widths";

/* ---------------------------------------------------------------------------
 * A table may not promise its columns more width than it reserves.
 *
 * `Table` is `table-fixed`: the declared widths ARE the layout, and where they
 * over-subscribe `minWidth` the browser quietly shrinks them to fit. The
 * column is then narrower than the number beside it says and its text
 * truncates early — on a real screen, at every width, with nothing anywhere
 * reporting it. Ten tables were over by 20 to 200 pixels when this was
 * written.
 *
 * Read off the source, like the timezone greps and the wire contract, because
 * there is no other layer that can see it: two numbers in two places are valid
 * TypeScript and valid JSX whatever they add up to.
 * ------------------------------------------------------------------------- */

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("no table promises its columns more width than it reserves", () => {
  const over: string[] = [];
  let seen = 0;
  for (const file of tsxFiles("src")) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("<Table")) continue;
    for (const d of tableDeclarations(source, file)) {
      seen += 1;
      if (d.fixed > d.minWidth) {
        over.push(
          `${d.where}: minWidth=${d.minWidth} but ${d.columns} fixed columns ask for ${d.fixed}`,
        );
      }
    }
  }
  assert.ok(seen > 40, `expected to have measured the suite's tables, saw ${seen}`);
  assert.deepEqual(over, []);
});
