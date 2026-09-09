import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CRM_EVENT, MBOS_EVENT } from "@/lib/timeline";

/**
 * §R — "Timeline entries should be generated automatically wherever possible."
 *
 * Two things can go wrong with a projection, and neither is visible at runtime.
 * A kind can be DECLARED and never written, which reads on a customer record as
 * a gap in their history rather than as a missing feature. And a kind can be
 * written as a bare LITERAL at its call site, which is worse: the natural key is
 * built from that string, so a typo produces a stream nothing will ever
 * deduplicate, because the conflict target can never match itself.
 *
 * This reads the source and checks both.
 */

const ROOT = join(import.meta.dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Comments are stripped first.
 *
 * A doc comment that QUOTES the string — `field-activity-projection-service.ts`
 * explains at length that it writes the same `"visit"` live check-ins do — is
 * documentation, not a write, and flagging it would teach people to delete the
 * explanation to quiet the test. `schema-usage.test.ts` on the handset strips
 * comments before parsing SQL for the same reason.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const SOURCE = sourceFiles(ROOT)
  .filter((f) => !f.endsWith("timeline.ts"))
  .map((f) => stripComments(readFileSync(f, "utf8")))
  .join("\n");

test("every declared event kind is actually written somewhere", () => {
  /* A kind declared and never written is a gap in a customer's history that
     reads as lost data rather than as an unbuilt feature. */
  const declared = { ...CRM_EVENT, ...MBOS_EVENT };
  const unwritten = Object.entries(declared)
    .filter(([name]) => {
      const crm = `CRM_EVENT.${name}`;
      const mbos = `MBOS_EVENT.${name}`;
      return !SOURCE.includes(crm) && !SOURCE.includes(mbos);
    })
    .map(([name]) => name);

  assert.deepEqual(
    unwritten,
    [],
    `declared and never written, so these never appear on any customer: ${unwritten.join(", ")}`,
  );
});

test("no timeline write names its kind as a bare string", () => {
  /* The natural key is (app, kind, source row). A literal that drifts by one
     character produces a stream that can never deduplicate against itself — so
     a retried sync writes a second copy, and the record reads as the salesman
     having visited twice. */
  const literals = [...SOURCE.matchAll(/eventType:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    literals,
    [],
    `write these through CRM_EVENT/MBOS_EVENT instead of a literal: ${literals.join(", ")}`,
  );
});

test("quotation is absent, and that is the honest answer", () => {
  /* §R asks for a Quotation entry. There is no quotation record in MahekOne to
     project FROM, and a timeline row with no source is not a projection — it is
     a sentence somebody typed, in a table whose entire discipline is that every
     row points back at the record that is the actual truth.
     
     This test exists so that adding a quotation table is what makes somebody
     delete it, rather than the gap being forgotten. */
  const kinds = Object.values({ ...CRM_EVENT, ...MBOS_EVENT }) as string[];
  assert.ok(
    !kinds.includes("quotation"),
    "a quotation kind now exists — build the record it projects from, then delete this test",
  );
});
