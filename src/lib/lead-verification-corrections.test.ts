import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MBOS_EVENT } from "@/lib/timeline";
import { VERIFICATION_FINDINGS, isVerificationFinding } from "@/lib/lead-labels";

/**
 * §8 — A CORRECTION IS A RECORD, AND IT IS NEVER AN EDIT.
 *
 * `lead_verification_corrections` exists because the four fixed
 * `confirmed_*` columns on `mbos_lead_validations` can say what the shop
 * answered and cannot say that the answer DIFFERED, what the salesman had, or
 * why — and five of the nine findings had no column at all and were folded into
 * one free-text note, where "how many leads had the wrong contact person" is a
 * grep rather than an answer.
 *
 * Two of the three things that matter about the write cannot be reached without
 * a database, so they are read out of the SOURCE instead, the way
 * `timeline-coverage.test.ts` reads the source for a bare event kind. That is a
 * weaker check than exercising the action and it is the one available cheaply:
 * the action needs the integration harness, and a rule nobody can afford to
 * test is a rule that drifts.
 *
 * What is pinned here:
 *
 *   1. The corrections are inserted through `tx`, inside the call's own
 *      transaction. A call that landed with its corrections missing would read
 *      on the record as a report that checked out, and the only way to record
 *      them afterwards is a second call — a second conversation on a history
 *      nobody had two of.
 *
 *   2. NOTHING in that path writes the corrected value onto the lead's own
 *      columns. AGENTS.md states it and the verify screen's own header restates
 *      it: the salesman's answer stays on the lead, the shop's is stored beside
 *      it, and the two disagreeing is the single most useful thing the call
 *      produces. Collapsing them would overwrite the first reading with the
 *      second and destroy exactly that.
 *
 *   3. The field rides in the timeline's SOURCE ID. One call corrects several
 *      findings, and the natural key is (app, kind, source row) — named by the
 *      bare call id they would collapse onto one row, the first would win, and
 *      the rest would never appear on the record at all.
 */

const ACTION = readFileSync(join(import.meta.dirname, "actions", "leads.ts"), "utf8");

/** Comments quote the rules at length here; a quotation is not a write. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const CODE = stripComments(ACTION);

test("the corrections are written in the call's own transaction", () => {
  assert.ok(
    /tx\.insert\(leadVerificationCorrections\)/.test(CODE),
    "corrections must be inserted through `tx`, beside the call row",
  );
  assert.ok(
    !/db\.insert\(leadVerificationCorrections\)/.test(CODE),
    "a correction written outside the transaction can land without its call, or fail after it",
  );
});

test("a correction never writes the lead's own columns", () => {
  /*
   * The one `customers` write in this action is the activity date and the
   * verified stamp. Anything a correction carries appearing in that object
   * would be the office overwriting the salesman's reading — so the set object
   * is read out and checked by name.
   */
  const set = CODE.match(
    /const set: Partial<typeof customers\.\$inferInsert> = \{([\s\S]*?)\n\s*\};/,
  );
  assert.ok(set, "the customers update in `recordLeadValidationCall` moved — re-read this test");

  const body = set[1];
  for (const banned of ["corrected", "corrections", "entry."]) {
    assert.ok(
      !body.includes(banned),
      `the customers update mentions \`${banned}\` — a correction is stored beside the lead's answer, never over it`,
    );
  }

  /* And the lead's own finding columns are not written anywhere in this file.
     These are what the nine findings were read FROM; the call answers into
     `mbos_lead_validations` and into the corrections table, and nowhere else. */
  for (const column of [
    "leadCompetitor",
    "leadRequirement",
    "leadMonthlyVolumeLitres",
    "potentialMonthlyPaise",
    "leadContactPerson",
    "leadDecisionMaker",
  ]) {
    assert.ok(
      !new RegExp(`${column}\\s*:`).test(CODE),
      `\`${column}\` is assigned in the verification action — the call must not write the lead's own answer`,
    );
  }
});

test("each corrected field gets its own timeline row", () => {
  assert.ok(
    CODE.includes("MBOS_EVENT.verificationCorrection"),
    "the correction entry must name its kind through the constant, never a literal",
  );
  assert.equal(MBOS_EVENT.verificationCorrection, "lead_verification_correction");
  assert.ok(
    /sourceRecordId:\s*`\$\{callId\}:correction:\$\{field\}`/.test(CODE),
    "the field belongs in the source id, or every correction from one call collapses onto one row",
  );
});

test("the action accepts exactly the nine findings the screen draws", () => {
  /* One validator, so the list a screen offers and the list the action stores
     cannot drift — a tenth finding added to the form and not to the validator
     is a correction silently dropped, which reads afterwards as a manager who
     never bothered. */
  for (const finding of VERIFICATION_FINDINGS) {
    assert.ok(isVerificationFinding(finding.id), `${finding.id} is not accepted`);
  }
  assert.ok(!isVerificationFinding("margin"), "an unknown field must be refused");

  const ids = VERIFICATION_FINDINGS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "two findings share an id, so one would overwrite the other");

  assert.ok(
    CODE.includes("isVerificationFinding(entry.field)"),
    "the action must validate the field against the shared list",
  );
});
