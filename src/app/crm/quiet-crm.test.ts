import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * THE CRM WEARS THE ERP'S LOOK, AND SAYS AS LITTLE AS IT CAN.
 *
 * Text checks over the source, because nothing at runtime can tell a label
 * that says "required" in words from one that carries the * — both render,
 * and the wordy one is simply the one this rule exists to retire.
 * ------------------------------------------------------------------------- */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

const CRM_FILES = ["src/app/crm", "src/components/crm", "src/components/customers"].flatMap((d) => walk(d));

test("the CRM shell asks for the v4 look, and the ERP and the CRM read one sheet", () => {
  const layout = read("src/app/crm/layout.tsx");
  assert.match(layout, /look="v4"/);
  assert.match(layout, /app="crm"/);
  assert.match(layout, /@\/styles\/v4-theme\.css/);
  assert.match(read("src/app/erp/layout.tsx"), /@\/styles\/v4-theme\.css/);
  assert.match(read("src/app/erp/_ui/erp-shell.tsx"), /data-v4\b/);
  /* Accounts shares AppShell and has not asked for the look. */
  assert.doesNotMatch(read("src/app/accounts/layout.tsx"), /look="v4"/);
});

/** A selector list split on its own commas, not the ones inside `:is(…)`. */
function topLevel(sel: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

test("every rule in the sheet is scoped to a marker, so it cannot follow somebody into another app", () => {
  const css = read("src/styles/v4-theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = css
    .split("}")
    .map((block) => block.split("{")[0]?.trim())
    .filter((sel): sel is string => Boolean(sel) && !sel.startsWith("@media"));
  for (const sel of selectors) {
    for (const part of topLevel(sel)) {
      const p = part.trim();
      if (!p) continue;
      assert.match(p, /^:root:has\(\[data-v4(-app="crm")?\]\)/, `unscoped selector: ${p}`);
    }
  }
});

test("a CRM label says required with a *, and optional in grey — never in its words", () => {
  const offenders: string[] = [];
  for (const f of CRM_FILES) {
    const src = read(f);
    for (const m of src.matchAll(/label=\{?["`]([^"`]*)["`]/g)) {
      if (/·\s*required|\((?:required|optional)\)/i.test(m[1])) offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the shared field reads required, optional and the hint tip", () => {
  const prim = read("src/components/ui/primitives.tsx");
  assert.match(prim, /required\?: boolean/);
  assert.match(prim, /optional\?: boolean/);
  assert.match(prim, /hintShown\?: boolean/);
  assert.match(prim, /ui-field-label/);
  assert.match(prim, /ui-hint-tip/);
});

test("the Customers list keeps every filter, behind one Filter button", () => {
  const src = read("src/components/customers/customers-screen.tsx");
  const open = src.indexOf("<FilterPanelButton");
  const close = src.indexOf("</FilterPanelButton>");
  assert.ok(open > 0 && close > open, "the filters sit inside the Filter button");
  const inside = src.slice(open, close);
  for (const label of ["Status", "Type", "Sales AM", "Sales manager", "Back office"]) {
    assert.match(inside, new RegExp(`label="${label}"`), `${label} is still offered`);
  }
  assert.match(inside, /<PlaceFilterSelects/, "state, district, city and area are still offered");
});
