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
  verificationVerdict,
  verificationVerdictFor,
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
