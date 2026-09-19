import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * THE RULES THAT MAKE THE DESKTOP RANGE AUTOMATIC.
 *
 * Everything in the four changes before this one is worth nothing on its own:
 * a shared frame that the ninth app does not render, and a `CardGrid` that the
 * next screen does not reach for, leave the suite exactly where it started —
 * eight roots each stating their own floor, 155 hand-typed column counts, and
 * a width rule that lives in somebody's memory of a pull request.
 *
 * These read the source, like the timezone greps and the wire contract, and
 * for the same reason: none of it is expressible in a type. A layout that
 * opens its own `h-screen` column compiles perfectly, renders perfectly at the
 * width its author happened to have, and is wrong everywhere else.
 *
 * WHAT IS DELIBERATELY NOT HERE is a rule against `grid-cols-2` and friends.
 * A two-column split of a form, a record page's main-and-aside, a definition
 * list — those are structure rather than a card shelf, and they are right at
 * every width. The rule is about the auto-fit spelling, which is the one that
 * was being re-typed with a different floor each time.
 * ------------------------------------------------------------------------- */

/** The apps with a browser shell. `field` is MBOS and has no web route. */
const APPS = ["crm", "accounts", "sales", "admin", "reports", "hrms", "enquiries", "founder"];

function filesUnder(dir: string, ext = ".tsx"): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, ext));
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const FRAME = "src/components/shell/app-frame.tsx";

test("every app's shell is the shared frame", () => {
  const missing: string[] = [];
  for (const app of APPS) {
    const files = filesUnder(join("src/app", app)).filter((f) => {
      const name = f.slice(f.lastIndexOf("/") + 1);
      // The layout, or the shell it hands off to — several apps keep the
      // client half in a `*-shell.tsx` beside it, and the console IS its page.
      return name === "layout.tsx" || name.endsWith("-shell.tsx") || name === "console.tsx";
    });
    /*
     * One hop of indirection, because the CRM's shell is not under its own
     * folder: `src/app/crm/layout.tsx` renders `AppShell`, which lives in
     * `components/shell` and is shared. Following the import is what tells a
     * shell that delegates from one that draws its own root — the difference
     * this test exists to catch.
     */
    const reachable = new Set(files);
    for (const f of files) {
      const source = readFileSync(f, "utf8");
      for (const m of source.matchAll(/from "(@\/components\/[^"]+)"/g)) {
        const candidate = "src/" + m[1].slice("@/".length) + ".tsx";
        if (existsSync(candidate)) reachable.add(candidate);
      }
    }
    const reaches = [...reachable].some((f) => readFileSync(f, "utf8").includes("AppFrame"));
    if (!reaches) missing.push(app);
  }
  assert.deepEqual(
    missing,
    [],
    "these apps draw their own root instead of AppFrame, so they carry their own floor and their own scroll model",
  );
});

test("no app states a width floor of its own", () => {
  const offenders: string[] = [];
  for (const app of APPS) {
    for (const file of filesUnder(join("src/app", app))) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/min-w-\[(\d+)px\]/g)) {
        // A table declaring its own minimum is a different thing entirely —
        // that is a column-width question, guarded by `table-widths.test.ts`.
        const line = source.slice(0, m.index).split("\n").pop() ?? "";
        if (line.includes("<table")) continue;
        if (Number(m[1]) >= 900) offenders.push(`${file}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "the floor is `--container-shell-floor`, read by AppFrame, and stated nowhere else",
  );
});

test("a card shelf is a CardGrid, never a re-typed auto-fit template", () => {
  const offenders: string[] = [];
  for (const file of [...filesUnder("src/app"), ...filesUnder("src/components")]) {
    if (file.endsWith("card-grid.tsx")) continue;
    if (readFileSync(file, "utf8").includes("repeat(auto-fit")) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    "use `CardGrid`: eighteen hand-typed copies of this template carried nine different minima",
  );
});

test("the frame is the only place the desktop range is stated", () => {
  const frame = readFileSync(FRAME, "utf8");
  assert.ok(
    frame.includes("min-w-shell-floor"),
    "the frame must read the floor token rather than a pixel literal",
  );
  const css = readFileSync("src/app/globals.css", "utf8");
  for (const token of [
    "--breakpoint-desk",
    "--breakpoint-wide",
    "--breakpoint-ultra",
    "--container-shell-floor",
    "--container-measure",
  ]) {
    assert.ok(css.includes(token), `${token} is missing from the design tokens`);
  }
});
