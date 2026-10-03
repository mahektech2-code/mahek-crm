import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { BASELINE, ADDED, FEATURES, MOVED, type HandlerKind, type HandlerRef } from "./feature-ledger";

/* The guard the restructure answers to: nothing the first build could do may
   disappear without a line in the ledger saying where it went. The screen
   modules import the database client, which wants a URL to exist; nothing here
   opens a connection. */
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";

const KINDS: HandlerKind[] = ["actions", "bulk", "forms", "formLoaders", "tools"];

async function current(): Promise<Map<string, Set<string>>> {
  const { hrmsScreenModule } = await import("./screens");
  const { HRMS_TABS } = await import("./registry");
  const out = new Map<string, Set<string>>();
  const keys = new Set([...HRMS_TABS.map((x) => x.tab.key), ...Object.keys(BASELINE)]);
  for (const key of keys) {
    const m = hrmsScreenModule(key);
    if (!m) continue;
    const ids = new Set<string>();
    for (const kind of KINDS) for (const id of Object.keys((m as Record<string, unknown>)[kind] ?? {})) ids.add(`${key}.${kind}.${id}`);
    out.set(key, ids);
  }
  return out;
}

const baselineRefs = (): HandlerRef[] =>
  Object.entries(BASELINE).flatMap(([key, h]) => KINDS.flatMap((kind) => (h[kind] ?? []).map((id) => `${key}.${kind}.${id}` as HandlerRef)));

const exists = (now: Map<string, Set<string>>, ref: string) => now.get(ref.split(".")[0])?.has(ref) ?? false;

test("every handler the first build had is where it was, or the ledger says where it went", async () => {
  const now = await current();
  const lost: string[] = [];
  for (const ref of baselineRefs()) {
    const moved = MOVED[ref];
    if (!moved) {
      if (!exists(now, ref)) lost.push(`${ref} — gone, and not in MOVED`);
      continue;
    }
    if ("at" in moved && !exists(now, moved.at)) lost.push(`${ref} → ${moved.at}, which does not exist`);
    if ("shared" in moved) {
      if (!existsSync(moved.file)) lost.push(`${ref} → ${moved.file}, which does not exist`);
      else if (!readFileSync(moved.file, "utf8").includes(moved.marker)) lost.push(`${ref} → ${moved.file} no longer contains “${moved.marker}”`);
    }
    if ("retired" in moved) assert.ok(moved.retired.length > 20, `${ref} is retired without a reason worth reading`);
  }
  assert.deepEqual(lost, []);
});

test("every handler there is now was there before, or is recorded as new", async () => {
  const now = await current();
  const before = new Set<string>(baselineRefs());
  const unrecorded = [...now.values()].flatMap((ids) => [...ids]).filter((ref) => !before.has(ref) && !ADDED[ref as HandlerRef]);
  assert.deepEqual(unrecorded, [], "a new handler needs a line in ADDED");
  for (const ref of Object.keys(ADDED)) assert.ok(exists(now, ref), `${ref} is recorded as added and does not exist`);
});

test("a move names a baseline handler, never an invented one", () => {
  const before = new Set<string>(baselineRefs());
  for (const ref of Object.keys(MOVED)) assert.ok(before.has(ref), `${ref} was never a handler`);
});

test("every feature is still in the file that does it", () => {
  const missing = Object.entries(FEATURES).filter(([, f]) => !existsSync(f.file) || !readFileSync(f.file, "utf8").includes(f.marker));
  assert.deepEqual(missing.map(([k, f]) => `${k}: ${f.file} — “${f.marker}”`), []);
});
