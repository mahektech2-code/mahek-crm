/**
 * §8 — the three things a verification call can establish, and the distinction
 * between the second and the third.
 *
 * This is a small test about a small function, and it is here because the
 * distinction it pins is the one a future reader is most likely to collapse.
 * `follow_up` and `not_qualified` both mean "the call did not go well", and
 * they are opposite answers: the first says our own salesman could not be
 * confirmed and closes NOTHING, the second says the opportunity is false and
 * closes the lead as lost. A refactor that mapped both onto one stored word
 * would compile, would look tidier, and would make every real shop that
 * somebody could not reach read afterwards as a fabrication.
 *
 * `verificationVerdict` is the way back — the record page reads a stored row
 * through it — so the two are asserted TOGETHER: a round trip is what proves
 * the column can be read as the outcome that was recorded, and each half alone
 * would pass on a pair that disagreed.
 *
 * Pure: no database, no clock, no configuration. The vocabulary lives in
 * `lib/lead-labels.ts` precisely so a form in a browser and a handset with no
 * signal can hold the same copy of it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  VERIFICATION_OUTCOMES,
  VERIFICATION_QUESTIONS,
  VERIFICATION_COLUMNS,
  VERIFICATION_SECTIONS,
  verificationVerdict,
  verificationVerdictFor,
  verificationResultOf,
  verificationResultLabel,
  type VerificationOutcome,
} from "../lead-labels";

describe("what a verification call can establish", () => {
  test("a verified call is the only one that reads back as a pass", () => {
    assert.equal(verificationVerdictFor("verified"), "confirmed");
    assert.equal(verificationVerdict(verificationVerdictFor("verified")), true);
  });

  test("a follow-up closes nothing and is NOT read back as a failure", () => {
    /* The whole argument in one assertion: what could not be confirmed is our
       salesman's visit, so the call is left undecided rather than turned into a
       verdict about the shop. `null` is what the record page draws as
       "nobody has decided anything yet". */
    assert.equal(verificationVerdictFor("follow_up"), "pending");
    assert.equal(verificationVerdict(verificationVerdictFor("follow_up")), null);
  });

  test("a false opportunity is the one outcome that reads back as a failure", () => {
    assert.equal(verificationVerdictFor("not_qualified"), "not_qualified");
    assert.equal(verificationVerdict(verificationVerdictFor("not_qualified")), false);
  });

  test("the two unsuccessful outcomes are never stored as the same word", () => {
    assert.notEqual(
      verificationVerdictFor("follow_up"),
      verificationVerdictFor("not_qualified"),
    );
  });

  test("every outcome the screens offer maps to a stored verdict", () => {
    /* The list is what both forms draw from, so an outcome added to it and not
       to the mapping would be a radio button that stores whatever `pending`
       happens to mean. */
    for (const o of VERIFICATION_OUTCOMES) {
      const stored = verificationVerdictFor(o.code);
      assert.ok(
        ["confirmed", "pending", "not_qualified"].includes(stored),
        `${o.code} stores nothing the column knows about`,
      );
      assert.ok(o.label.trim().length > 0, `${o.code} has no label`);
      assert.ok(o.says.trim().length > 0, `${o.code} does not say what it costs`);
    }
    const codes = VERIFICATION_OUTCOMES.map((o) => o.code);
    assert.deepEqual(codes, ["verified", "follow_up", "not_qualified"] satisfies
      VerificationOutcome[]);
  });

  test("the outcome that closes the lead says so before the button is pressed", () => {
    /* Not a style check. The two unsuccessful outcomes are a sentence apart on
       the screen, and the sentence is the only thing stopping a manager reaching
       for the closing one because a call went badly — so the words that say it
       closes the lead are pinned here rather than left to whoever edits the
       screen next. */
    const closing = VERIFICATION_OUTCOMES.find((o) => o.code === "not_qualified");
    assert.ok(closing);
    assert.match(closing.says, /CLOSES the lead/);
    const followUp = VERIFICATION_OUTCOMES.find((o) => o.code === "follow_up");
    assert.ok(followUp);
    assert.doesNotMatch(followUp.says, /close/i);
  });
});

describe("§5.2's fourth result, which is derived and not stored", () => {
  test("a clean verification and a corrected one do not read as one word", () => {
    /* The whole point of the four-way split: "how many of our salesmen's
       reports survived the call unchanged" is unanswerable while both of these
       come back as `verified`. */
    assert.equal(verificationResultOf(true, 0), "verified");
    assert.equal(verificationResultOf(true, 3), "verified_with_corrections");
    assert.notEqual(verificationResultOf(true, 0), verificationResultOf(true, 1));
  });

  test("it reads the same tri-state the record page already holds", () => {
    /* `verificationVerdict` is the one mapping from the stored column, and this
       takes its answer rather than a second copy of it — a reader that had to
       know `confirmed` means verified would be that copy. */
    assert.equal(verificationResultOf(verificationVerdict("confirmed"), 0), "verified");
    assert.equal(verificationResultOf(verificationVerdict("pending"), 0), "follow_up");
  });

  test("only a verified call can carry it", () => {
    /* A follow-up could not confirm the visit and a failed verification found
       no opportunity. On neither does "and three figures were corrected" say
       anything about whether the report stood up — it was never accepted. */
    assert.equal(verificationResultOf(null, 4), "follow_up");
    assert.equal(verificationResultOf(false, 4), "not_qualified");
  });

  test("it is NOT an outcome anybody can pick", () => {
    /* The three outcomes are judgements a manager makes on the call. Whether he
       corrected anything is a count of what he did, and a radio for it would let
       one be recorded with no corrections behind it — a second copy of a fact
       the rows already state, free to disagree with them from its first
       afternoon. */
    const codes = VERIFICATION_OUTCOMES.map((o) => o.code);
    assert.ok(!codes.includes("verified_with_corrections" as VerificationOutcome));
  });

  test("the three that are also outcomes take their words from the one list", () => {
    for (const o of VERIFICATION_OUTCOMES) {
      assert.equal(verificationResultLabel(o.code), o.label);
    }
    assert.match(verificationResultLabel("verified_with_corrections"), /corrections/i);
  });
});

describe("§5.2's four sections", () => {
  test("every question names a section that exists", () => {
    const known = new Set(VERIFICATION_SECTIONS.map((s) => s.id));
    for (const q of VERIFICATION_QUESTIONS) {
      assert.ok(known.has(q.section), `${q.id} is in no section the forms draw`);
    }
  });

  test("no section is empty, or a heading draws over nothing", () => {
    for (const s of VERIFICATION_SECTIONS) {
      assert.ok(
        VERIFICATION_QUESTIONS.some((q) => q.section === s.id),
        `${s.id} has no questions`,
      );
    }
  });

  test("every question has somewhere to land", () => {
    /* An answer with no column is an answer the action drops on the floor, in
       silence — the form takes it, the manager watches it save, and the record
       reads afterwards as a question nobody asked. */
    for (const q of VERIFICATION_QUESTIONS) {
      assert.ok(VERIFICATION_COLUMNS[q.id], `${q.id} has no column on mbos_lead_validations`);
    }
  });

  test("C and D are asked, which is the gap this closed", () => {
    const ids = new Set(VERIFICATION_QUESTIONS.map((q) => q.id));
    /* The PRD's five objections, of which quality is ours and stays. */
    for (const id of ["price_issue", "credit_concern", "service_issue", "competitor_concern",
      "quality_issue"]) {
      assert.ok(ids.has(id), `objection ${id} is not asked`);
    }
    /* §5.4 decides whether a sample goes out on the first of these. */
    for (const id of ["ready_for_trial", "ready_for_commercial", "ready_for_order"]) {
      assert.ok(ids.has(id), `readiness ${id} is not asked`);
    }
  });
});
