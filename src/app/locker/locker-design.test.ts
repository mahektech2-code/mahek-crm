import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/* ---------------------------------------------------------------------------
 * THE LOCKER WEARS THE ERP'S LOOK, AND ONLY THAT LOOK.
 *
 * It was first drawn to its own design, every colour a hex in an inline style
 * — 745 of them — and moved onto the v4 design system the ERP, CRM, HRMS,
 * Tasks and Studio share. These rules keep it there: a screen that types a
 * hex, or reaches for the old violet, has stopped matching the rest of
 * MahekOne and nothing else would notice. Colours are v4 tokens — Tailwind
 * classes, or `C.*` / `var(--color-…)`, which resolve to the same tokens.
 * ------------------------------------------------------------------------- */

const ROOTS = [join(process.cwd(), "src/app/locker")];
const EXTRA = [join(process.cwd(), "src/lib/locker/style.ts"), join(process.cwd(), "src/lib/locker/engine.ts")];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

const ALL = [...ROOTS.flatMap(files), ...EXTRA].map((p) => ({ rel: relative(process.cwd(), p), src: readFileSync(p, "utf8") }));

function offenders(re: RegExp): string[] {
  const out: string[] = [];
  for (const f of ALL) {
    f.src.split("\n").forEach((line, i) => {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
      if (re.test(line)) out.push(`${f.rel}:${i + 1}  ${line.trim().slice(0, 140)}`);
    });
  }
  return out;
}

test("no colour is typed as hex in the Locker", () => {
  assert.deepEqual(offenders(/["'`]#[0-9a-fA-F]{3,8}\b|[:(,\s]#[0-9a-fA-F]{6}\b/), [], "Use a v4 token: a Tailwind class, or C.* / var(--color-…).");
});

test("the Locker's old violet is gone", () => {
  assert.deepEqual(offenders(/v50|v100|v500|v700|v900/i).filter((l) => !/lib\/locker\/style\.ts/.test(l)), [], "The vault is marked by its lock and the Restricted badge, not a colour of its own.");
});

test("the shell is the v4 frame", () => {
  const shell = ALL.find((f) => f.rel.endsWith("_ui/locker-shell.tsx"))!.src;
  assert.match(shell, /data-v4\b/);
  assert.match(shell, /data-v4-header/);
  assert.match(shell, /<CollapsibleNav\b/);
  const layout = ALL.find((f) => f.rel.endsWith("locker/layout.tsx"))!.src;
  assert.match(layout, /styles\/v4-theme\.css/);
});
