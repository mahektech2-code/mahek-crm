import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/* ---------------------------------------------------------------------------
 * THE ERP DRAWS ONE PIECE ONE WAY.
 *
 * Every rule here was broken somewhere when it was written: twenty-two
 * spellings of the small uppercase label, four heading sizes, three checkbox
 * looks, two popover shadows, money and dates formatted by hand. A screen that
 * reached for a class string instead of the shared piece was the cause every
 * time, so the test reads the source and refuses the class string.
 *
 * The homes are listed in ERP → Overview → Developer, "One home for each
 * shared piece". Label printing is left out: a label is millimetres and points
 * on a sticker, not a screen.
 * ------------------------------------------------------------------------- */

const ROOT = join(process.cwd(), "src/app/erp");
const SKIP = ["print-labels/"];
/** Where the shared pieces themselves are written. */
const HOMES = new Set(["_ui/look.tsx"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(n) ? [p] : [];
  });
}

const SOURCES = files(ROOT)
  .map((p) => ({ rel: relative(ROOT, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8") }))
  .filter((f) => !SKIP.some((s) => f.rel.startsWith(s)));

/** Code only: comments say what was wrong, and must be allowed to. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function offenders(re: RegExp, opts: { home?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const f of SOURCES) {
    if (!opts.home && HOMES.has(f.rel)) continue;
    code(f.text)
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line)) out.push(`${f.rel}:${i + 1}  ${line.trim().slice(0, 140)}`);
      });
  }
  return out;
}

const rule = (name: string, re: RegExp, why: string) =>
  test(name, () => {
    const found = offenders(re);
    assert.deepEqual(found, [], `${why}\n  ${found.join("\n  ")}`);
  });

rule("no colour is typed as hex", /["'`]#[0-9a-fA-F]{3,8}\b/, "Use a colour token from globals.css.");
rule("no font size is typed in pixels", /\btext-\[\d+(\.\d+)?(px|rem)\]/, "Use text-2xs / text-xs / text-meta / text-sm / text-md / text-base / text-lg.");
rule("no letter-spacing is typed", /\btracking-\[/, "Use tracking-label, or the Eyebrow / SectionLabel / labelClass that carries it.");
rule("a popover casts the one shadow", /\bshadow-\[0_8px/, "Use popoverClass (or shadow-pop).");
rule("no raw Tailwind palette colour", /\b(bg|text|border|ring|fill|stroke)-(gray|slate|zinc|stone|red|orange|amber|yellow|green|emerald|teal|sky|blue|indigo|violet|purple|pink|rose|black)-\d/, "Use the design tokens.");
rule(
  "no heading is drawn by hand",
  /<h[1-6][\s>]/,
  "Use Page / SectionTitle / SubTitle / SectionLabel from _ui/look.tsx.",
);
rule(
  "no small uppercase label is typed out",
  /className=(["'`])[^"'`]*\buppercase\b/,
  "Use Eyebrow / eyebrowClass (11px) or SectionLabel / labelClass (12px) from _ui/look.tsx.",
);
test("a bare checkbox uses checkboxClass", () => {
  /* Read the whole tag, not one line: a formatter may put className on its own line. */
  const found: string[] = [];
  for (const f of SOURCES) {
    const c = code(f.text);
    for (const m of c.matchAll(/type="checkbox"/g)) {
      const start = c.lastIndexOf("<input", m.index);
      const end = c.indexOf("/>", m.index);
      const tag = c.slice(start, end);
      if (!/checkboxClass/.test(tag)) found.push(`${f.rel}:${c.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(found, [], `Use Checkbox, or className={checkboxClass} from primitives.\n  ${found.join("\n  ")}`);
});
rule("money, numbers and times are formatted in one place", /toLocale(String|DateString|TimeString)\(|timeZone:/, "Use inr / inrRate / nf / fd (lib/erp/ui) or stamp / stampDate / clock (lib/format).");
rule("no ERP address is typed", /["'`]\/erp\//, "Use erpLink / erpHref or the builders in trace-links.ts.");
rule("no table cell is drawn bare", /<t[hd][\s>]/, "Use Th / Td (and Tr) from primitives.");

test("a dialog names itself with DialogTitle", () => {
  const found = offenders(/text-xl leading-7 font-semibold text-ink"/).filter((l) => !l.startsWith("_ui/dialog.tsx"));
  assert.deepEqual(found, [], `Use DialogTitle from _ui/dialog.tsx.\n  ${found.join("\n  ")}`);
});

test("the type kit is what the rules point to", () => {
  const kit = SOURCES.find((f) => f.rel === "_ui/look.tsx");
  assert.ok(kit, "_ui/look.tsx is missing");
  for (const name of ["toggleClass", "LinkButton", "IconButton", "linkClass", "SectionTitle", "SubTitle", "Eyebrow", "eyebrowClass", "labelClass", "popoverClass"]) {
    assert.match(kit.text, new RegExp(`export (function|const) ${name}\\b`), `${name} is not exported`);
  }
});
