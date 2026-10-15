/* ---------------------------------------------------------------------------
 * THE FACTORY PHONE APP READS THE SERVER'S RULES, AND ONLY THE PURE ONES.
 *
 * factory-mobile/ imports `@/lib/...` straight from this tree (its Metro
 * config maps `@/` to ../src), so "is this scan allowed" has one answer on
 * the phone and the server. The price is that a server module reached from
 * there would be bundled into an APK — a database driver, `server-only`, a
 * secret's name — and an APK cannot be recalled. This pins the list: a new
 * import from the phone has to be added here, by somebody looking at it.
 * ------------------------------------------------------------------------- */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const APP = path.join(ROOT, "factory-mobile");
const ALLOWED = new Set(["@/lib/factory/rules", "@/lib/factory/types", "@/lib/factory/i18n", "@/lib/factory/time", "@/lib/hrms/qr", "@/lib/business-date"]);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "android" || e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Value imports (and re-exports) of `@/…`; `import type` is erased and ships nothing. */
function valueImports(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(?!type\b)[^;]*?from\s+"(@\/[^"]+)"/gm)) out.push(m[2]);
  return out;
}

test("the phone app imports only the pure, client-safe server modules", () => {
  const seen = new Set<string>();
  for (const f of files(APP)) for (const m of valueImports(f)) {
    seen.add(m);
    assert.ok(ALLOWED.has(m), `${path.relative(ROOT, f)} imports ${m}, which is not on the phone's allow-list`);
  }
  assert.ok(seen.has("@/lib/factory/rules"), "expected the phone to share the server's scan rules");
});

test("every module the phone may import is itself free of server code, all the way down", () => {
  const visit = (spec: string, from: string[]): void => {
    const base = path.join(ROOT, "src", spec.slice(2));
    const file = [base + ".ts", base + ".tsx"].find((f) => fs.existsSync(f));
    assert.ok(file, `${spec} does not resolve`);
    const src = fs.readFileSync(file!, "utf8");
    assert.ok(!/["']server-only["']|from\s+["']@\/db|from\s+["']drizzle-orm|from\s+["']next\//.test(src), `${spec} (via ${from.join(" → ")}) reaches server code`);
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"(@\/[^"]+|\.\/[^"]+)"/gm)) {
      const next = m[1].startsWith("./") ? "@/" + path.posix.join(path.posix.dirname(spec.slice(2)), m[1]) : m[1];
      visit(next, [...from, spec]);
    }
  };
  for (const m of ALLOWED) visit(m, []);
});
