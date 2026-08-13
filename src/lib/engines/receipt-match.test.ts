import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  blocksSilentDuplicate,
  matchReceipts,
  normaliseReference,
  type MatchCandidate,
} from "./receipt-match";

/* ====================================== E11 — the same money, twice
 *
 * What these pin is which candidates are OFFERED and in what order. Nothing
 * here merges anything: the whole engine is a suggestion, and the tests are
 * about not suggesting nonsense and not staying silent when it matters.
 */

const CFG = { matchWindowDays: 45, matchTolerancePercent: 2 };

function candidate(over: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    receiptId: "rcp_1",
    amount: 50_000_00,
    receivedAt: "2026-08-10",
    mode: "Bank transfer",
    reference: null,
    status: "reported",
    reportedByName: "Priya",
    reportedOn: "2026-08-11",
    note: null,
    ...over,
  };
}

const entry = {
  amount: 50_000_00,
  receivedAt: "2026-08-10",
  mode: "Bank transfer",
  reference: null as string | null,
};

describe("E11 receipt matching", () => {
  test("the same amount on the same day is offered as an exact match", () => {
    const [m] = matchReceipts([candidate()], entry, CFG);
    assert.equal(m.strength, "exact");
    assert.equal(m.differsBy, 0);
    assert.ok(blocksSilentDuplicate(m), "an exact match must not be walked past silently");
  });

  test("a reference that agrees beats an amount that agrees", () => {
    const byAmount = candidate({ receiptId: "rcp_amount" });
    const byRef = candidate({
      receiptId: "rcp_ref",
      amount: 49_000_00,
      reference: "UTR 1234 5678",
    });

    const out = matchReceipts([byAmount, byRef], { ...entry, reference: "utr-12345678" }, CFG);
    assert.equal(out[0].candidate.receiptId, "rcp_ref");
    assert.equal(out[0].strength, "reference");
  });

  test("a reference match is offered even when the amounts disagree, and says so", () => {
    // One of the two figures is wrong and it is usually the one taken down a
    // phone. That is the most useful thing this can tell somebody.
    const [m] = matchReceipts(
      [candidate({ amount: 45_000_00, reference: "UTR12345678" })],
      { ...entry, reference: "UTR12345678" },
      CFG,
    );
    assert.equal(m.strength, "reference");
    assert.equal(m.differsBy, 5_000_00);
    assert.match(m.why, /written down/);
  });

  test("bank charges are a question, not an answer", () => {
    const [m] = matchReceipts([candidate({ amount: 50_040_00 })], entry, CFG);
    assert.equal(m.strength, "close");
    assert.equal(m.differsBy, 40_00);
    assert.equal(
      blocksSilentDuplicate(m),
      false,
      "a close match must not stand in the way of ordinary work",
    );
  });

  test("outside the tolerance nothing is offered at all", () => {
    assert.equal(matchReceipts([candidate({ amount: 60_000_00 })], entry, CFG).length, 0);
  });

  test("a zero tolerance offers only exact amounts", () => {
    const out = matchReceipts([candidate({ amount: 50_040_00 })], entry, {
      ...CFG,
      matchTolerancePercent: 0,
    });
    assert.equal(out.length, 0);
  });

  test("the window is measured from the day the money arrived, both ways", () => {
    // A telecaller writes Friday's payment down on Monday; a statement is read
    // a week later. The day of ARRIVAL is the only date the two records share.
    const before = candidate({ receivedAt: "2026-07-20" }); // 21 days earlier
    const after = candidate({ receiptId: "rcp_2", receivedAt: "2026-08-30" }); // 20 days later
    const far = candidate({ receiptId: "rcp_3", receivedAt: "2026-05-01" });

    const out = matchReceipts([before, after, far], entry, CFG);
    assert.equal(out.length, 2, "one inside the window on each side, and the far one dropped");
  });

  test("a held receipt is offered before a merely reported one", () => {
    const reported = candidate({ receiptId: "rcp_reported", status: "reported" });
    const held = candidate({ receiptId: "rcp_held", status: "held" });

    const out = matchReceipts([reported, held], entry, CFG);
    assert.equal(
      out[0].candidate.receiptId,
      "rcp_held",
      "somebody in accounts is already looking for exactly this money",
    );
  });

  test("two receipts with no reference are not evidence of anything", () => {
    // Both normalise to null, and null must never equal null here — otherwise
    // every unreferenced receipt matches every other one.
    const [m] = matchReceipts([candidate({ amount: 50_000_00 })], entry, CFG);
    assert.equal(m.strength, "exact", "matched on the amount, not on two absent references");
  });
});

describe("references as the bank means them", () => {
  test("case, spaces, punctuation and a leading label are all noise", () => {
    const forms = ["UTR 1234 5678", "utr-12345678", "1234-5678", "  Ref: 12345678 "];
    for (const f of forms) {
      assert.equal(normaliseReference(f), "12345678", `${f} did not normalise`);
    }
  });

  test("too short to name anything is the same as nothing", () => {
    // "1" and "OK" have both been typed into that box.
    assert.equal(normaliseReference("1"), null);
    assert.equal(normaliseReference("OK"), null);
    assert.equal(normaliseReference(""), null);
    assert.equal(normaliseReference(null), null);
  });

  test("a label that IS the reference is not eaten", () => {
    // "UPI" stripped off "UPI123456" leaves a real reference; stripping must
    // not turn a short one into nothing it can match on by accident.
    assert.equal(normaliseReference("UPI123456"), "123456");
  });
});
