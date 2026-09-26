/**
 * What the Sales Manager pipeline must NEVER become again, pinned by reading the
 * source — the same trick `mbos-wire.test.ts` and `layout-rules.test.ts` use,
 * for the same reason: every failure below type-checks, lints, renders and looks
 * right on a fixture.
 *
 * Pure. No database. The behaviour is `sales-manager-pipeline.test.ts`'s; this
 * file is about what is NOT in the tree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { GENERIC_FAILURE, NETWORK_FAILURE, safeMessage } from "@/lib/sales-lead-pipeline/errors";
import { getModule } from "@/lib/modules";

const ROOT = process.cwd();
const DIRS = ["src/components/sales-lead-pipeline", "src/lib/sales-lead-pipeline", "src/app/sales-lead-pipeline"];
const EXTRA = ["src/lib/actions/sales-manager-pipeline.ts"];

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

const FILES = [...DIRS.flatMap(walk), ...EXTRA].filter((f) => /\.(ts|tsx)$/.test(f));
const text = (f: string) => readFileSync(join(ROOT, f), "utf8");

/** The test files that live beside the feature may name the forbidden things to forbid them. */
const NOT_TESTS = FILES.filter((f) => !/\.test\.tsx?$/.test(f));

test("the prototype's mock data is gone, and nothing imports it", () => {
  assert.equal(existsSync(join(ROOT, "src/lib/sales-lead-pipeline/mock-data.ts")), false);
  for (const f of NOT_TESTS) {
    const src = text(f);
    for (const forbidden of ["mock-data", "seedLeads", "MOCK_TODAY", "PEOPLE_LIST", "PROSPECT_REASONS", "QUALIFICATION_CONDITIONS", "SAMPLE_REASONS", "ORDER_BLOCKERS"]) {
      // `QUALIFICATION_CONDITIONS` etc. are the prototype's exports; the REAL engine's are reached through `checklistFor`.
      const re = new RegExp(`\\b${forbidden}\\b`);
      assert.equal(re.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), false, `${f} still uses ${forbidden}`);
    }
  }
});

test("no hardcoded person, and no fictional lead id, is left in the feature", () => {
  for (const f of NOT_TESTS) {
    const code = text(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.equal(/["'`]amit["'`]/i.test(code), false, `${f} names the prototype's Amit`);
    assert.equal(/Good morning, Amit/.test(code), false, `${f} greets a person who is not signed in`);
    assert.equal(/\bLD-\d{3,}\b/.test(code), false, `${f} carries a fictional lead id`);
    assert.equal(/2026-09-\d\d/.test(code), false, `${f} carries a hardcoded date`);
  }
});

test("business data is never held in browser storage, and no client file imports the database", () => {
  for (const f of NOT_TESTS) {
    const code = text(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.equal(/localStorage|sessionStorage|indexedDB/.test(code), false, `${f} touches browser storage`);
    if (f.startsWith("src/components/")) {
      assert.equal(/from "@\/db/.test(code), false, `${f} is a component and imports the database`);
      assert.equal(/server-only/.test(code), false, `${f} is a component and imports a server-only module`);
    }
  }
  /* The provider holds a lead it was HANDED — never a list it could add to. */
  const provider = text("src/components/sales-lead-pipeline/provider.tsx");
  assert.equal(/useState<Lead\[\]>|setLeads|useState\(\(\) => seed/.test(provider), false);
});

test("the route is guarded like the module it is: the Sales grant first, then sales.leads", () => {
  const layout = text("src/app/sales-lead-pipeline/layout.tsx");
  assert.match(layout, /requireUser\(\)/);
  assert.match(layout, /listUserApps\(user\.id\)/);
  assert.match(layout, /apps\.includes\("sales"\)/);
  assert.match(layout, /redirect\("\/apps"\)/);
  assert.match(layout, /requireModule\(user\.id, "sales\.leads"\)/);
  assert.ok(layout.indexOf("apps.includes") < layout.indexOf("requireModule("), "the grant is asked before the module");

  const mod = getModule("sales.leads");
  assert.ok(mod, "the module the layout names exists");
  assert.equal(mod.app, "sales");
});

test("every screen reads the database on each request, and none of them is cached past a save", () => {
  for (const f of ["page.tsx", "list/page.tsx", "pipeline/page.tsx", "[id]/page.tsx"]) {
    assert.match(text(`src/app/sales-lead-pipeline/${f}`), /export const dynamic = "force-dynamic"/, f);
  }
});

test("the four states a screen owes are drawn: loading, not found, failure, and empty", () => {
  for (const f of ["loading.tsx", "not-found.tsx", "error.tsx"]) {
    assert.ok(existsSync(join(ROOT, "src/app/sales-lead-pipeline", f)), `${f} is missing`);
  }
  assert.match(text("src/app/sales-lead-pipeline/[id]/page.tsx"), /if \(!found\) notFound\(\)/);
  assert.match(text("src/components/sales-lead-pipeline/list-screen.tsx"), /No leads match this filter/);
  assert.match(text("src/components/sales-lead-pipeline/dashboard-screen.tsx"), /Nothing overdue/);
  /* The error boundary prints ours, never the thrown message. */
  assert.equal(/error\.message/.test(text("src/app/sales-lead-pipeline/error.tsx")), false);
});

test("every control the server can offer is one the record screen draws", () => {
  const union = text("src/lib/sales-lead-pipeline/types.ts");
  const kinds = [...union.matchAll(/\{ kind: "([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 20, "found the GateAction kinds");
  const screen = text("src/components/sales-lead-pipeline/lead-record-screen.tsx");
  for (const k of new Set(kinds)) {
    assert.match(screen, new RegExp(`"${k}"`), `the record screen never draws a "${k}" control — a lead that reaches it has no way forward`);
  }
});

test("every dialog kind the screens open has a dialog", () => {
  const types = text("src/lib/sales-lead-pipeline/types.ts");
  const block = /export type ModalKind =([\s\S]*?);/.exec(types)![1];
  const kinds = [...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
  const modals = text("src/components/sales-lead-pipeline/modals.tsx");
  for (const k of kinds) assert.match(modals, new RegExp(`case "${k}":`), `no dialog for "${k}"`);
});

test("the service asks the same questions the real screens ask, and narrows by the same scope", () => {
  const service = text("src/lib/sales-lead-pipeline/sales-manager-pipeline-service.ts");
  for (const fn of ["leadTileCounts", "funnelByRung", "verificationQueue", "commitments", "negotiationDesk", "sampleDesk", "leadsPage", "leadRecord", "managerCalls", "leadTimelinePage", "leadSamplesFor", "leadApprovalChain", "distributorProfileFor", "gateForNext", "gateAction", "nextActionOwnerCandidates"]) {
    assert.match(service, new RegExp(`\\b${fn}\\b`), `the service does not compose ${fn}`);
  }
  /* The two counts nothing else provides are asked through the SAME scope. */
  const own = /async function verificationCounts[\s\S]*?\n}\n/.exec(service)![0];
  assert.match(own, /leadsVisible\(scope\)/);
  assert.match(own, /managerScope\(\)/);
  /* A page of the book is never asked for whole. */
  assert.equal(/perPage:\s*(\d{4,}|Infinity)/.test(service), false);
});

test("the actions add no permission of their own, and never call the database around an existing action", () => {
  const actions = text("src/lib/actions/sales-manager-pipeline.ts");
  assert.match(actions, /^"use server";/);
  /* Only the six thin orchestrations exist; anything else is a second copy of a signature. */
  const exported = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(exported, ["convertProspect", "markLeadLost", "receiveSampleForLead", "requestSampleForLead", "reviewSampleForLead", "verifyProspect"]);
  /* No writes of its own to the tables the real actions own. */
  assert.equal(/db\.(insert|update|delete)\(/.test(actions), false, "an orchestration that writes has become a second implementation");
  assert.equal(/gateTo|gateForNext/.test(actions), false, "the gate is decided by the action it calls");
});

test("a failure is shown as a sentence, never as the database talking", () => {
  const raw = [
    'Failed query: select "id" from "customers" where "id" = $1 params: cus_1',
    'relation "lead_stage_transitions" does not exist',
    'duplicate key value violates unique constraint "customers_pkey"',
    "connect ECONNREFUSED 127.0.0.1:5432",
    "TypeError: Cannot read properties of undefined (reading 'id')\n    at run (file:///app/x.js:1:1)",
    "insert into orders (id) values ($1)",
    "NEXT_REDIRECT",
    "",
    undefined,
  ];
  for (const r of raw) assert.equal(safeMessage(r), GENERIC_FAILURE, String(r));

  const authored = [
    "Qualification is not open yet. 2 things still to do.",
    "A refusal needs a reason — the salesman has to tell the customer something.",
    "Somebody has already decided this one.",
    "You do not have permission to do that.",
  ];
  for (const a of authored) assert.equal(safeMessage(a), a);
  assert.match(NETWORK_FAILURE, /nothing was saved/i);
  assert.match(GENERIC_FAILURE, /nothing was saved/i);
  assert.equal(safeMessage("x".repeat(700)), GENERIC_FAILURE, "a dump is not a sentence");
});
