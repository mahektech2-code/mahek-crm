/**
 * The seven answers a Suspect needs before it is a Prospect, and what makes each
 * one a real answer. Pure: the same file the dialog and the server both run.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  PROSPECT_ANSWERS,
  faultFor,
  mergeProspectAnswers,
  prospectAnswerFaults,
  type ProspectAnswers,
} from "./lead-prospect-answers";

const TODAY = "2026-10-24";
const REASONS = ["regular_requirement", "price_sensitive"];

const complete = (over: Partial<ProspectAnswers> = {}): ProspectAnswers => ({
  customerType: "retailer",
  monthlyLitres: 1000,
  competitor: "Ashoka",
  requiredProductId: "prd_1",
  contactPerson: "Mr Shashi Gupta",
  nextAction: "Call back with the price list",
  nextActionDate: "2026-11-02",
  reasonCode: "regular_requirement",
  ...over,
});
const faults = (a: ProspectAnswers, requireFutureDate = true) =>
  prospectAnswerFaults(a, { today: TODAY, reasonCodes: REASONS, requireFutureDate });

describe("the seven", () => {
  test("they are the gate's own seven, in the gate's order", () => {
    assert.deepEqual(
      PROSPECT_ANSWERS.map((a) => a.id),
      ["customer_type", "monthly_litres", "competitor", "required_product", "contact_person", "next_action", "prospect_reason"],
    );
  });

  test("all seven valid: no fault", () => {
    assert.deepEqual(faults(complete()), []);
  });
});

describe("one missing answer blocks, and is named", () => {
  const cases: Array<[string, Partial<ProspectAnswers>, string]> = [
    ["business type", { customerType: null }, "customerType"],
    ["monthly litres", { monthlyLitres: null }, "monthlyLitres"],
    ["competitor", { competitor: null }, "competitor"],
    ["product", { requiredProductId: null }, "requiredProductId"],
    ["contact person", { contactPerson: null }, "contactPerson"],
    ["next action text", { nextAction: null }, "nextAction"],
    ["next action day", { nextActionDate: null }, "nextActionDate"],
    ["reason", { reasonCode: null }, "reasonCode"],
  ];
  for (const [name, over, field] of cases) {
    test(name, () => {
      const f = faults(complete(over));
      assert.equal(f.length, 1);
      assert.equal(f[0]!.field, field);
      assert.ok(f[0]!.message.length > 5);
    });
  }

  test("several missing: every one is reported at once", () => {
    const f = faults(complete({ customerType: null, competitor: null, reasonCode: null, monthlyLitres: null }));
    assert.deepEqual(f.map((x) => x.field).sort(), ["competitor", "customerType", "monthlyLitres", "reasonCode"]);
  });
});

describe("blank is not an answer", () => {
  test("whitespace-only text is missing", () => {
    for (const field of ["competitor", "contactPerson", "nextAction", "requiredProductId", "customerType", "reasonCode"] as const) {
      const f = faults(complete({ [field]: "    " } as Partial<ProspectAnswers>));
      assert.equal(f.length, 1, field);
      assert.equal(f[0]!.field, field);
    }
  });

  test("an empty string is missing, not zero", () => {
    assert.equal(faults(complete({ monthlyLitres: "" }))[0]!.field, "monthlyLitres");
  });
});

describe("invalid is not an answer", () => {
  test("litres: zero, negative, not a number, absurd", () => {
    for (const v of [0, -5, "abc", Number.NaN, 20_000_000, "0"]) {
      assert.equal(faults(complete({ monthlyLitres: v as never }))[0]?.field, "monthlyLitres", String(v));
    }
  });
  test("litres: a number or a numeric string is fine", () => {
    assert.deepEqual(faults(complete({ monthlyLitres: "250.5" })), []);
    assert.deepEqual(faults(complete({ monthlyLitres: 0.5 })), []);
  });
  test("business type must be one of the listed", () => {
    assert.equal(faults(complete({ customerType: "banana" }))[0]?.field, "customerType");
  });
  test("a competitor is a name, not a letter", () => {
    assert.equal(faults(complete({ competitor: "x" }))[0]?.field, "competitor");
  });
  test("a contact person is a name: needs a letter and two characters", () => {
    for (const v of ["-", "9820011234", "?!", "A"]) {
      assert.equal(faults(complete({ contactPerson: v }))[0]?.field, "contactPerson", v);
    }
  });
  test("the next step needs a few words and a real day", () => {
    assert.equal(faults(complete({ nextAction: "ok" }))[0]?.field, "nextAction");
    assert.equal(faults(complete({ nextActionDate: "2026-02-31" }))[0]?.field, "nextActionDate");
    assert.equal(faults(complete({ nextActionDate: "tomorrow" }))[0]?.field, "nextActionDate");
  });
  test("a TYPED next-step day may not be in the past; one on the record may be overdue", () => {
    assert.equal(faults(complete({ nextActionDate: "2026-10-01" }), true)[0]?.field, "nextActionDate");
    assert.deepEqual(faults(complete({ nextActionDate: "2026-10-01" }), false), []);
    assert.deepEqual(faults(complete({ nextActionDate: TODAY }), true), []);
  });
  test("the reason must be one the configuration lists", () => {
    assert.equal(faults(complete({ reasonCode: "because" }))[0]?.field, "reasonCode");
  });
  test("faultFor agrees with the list", () => {
    assert.equal(faultFor("competitor", complete({ competitor: "" }), { today: TODAY })?.field, "competitor");
    assert.equal(faultFor("competitor", complete(), { today: TODAY }), null);
  });
});

describe("what the record holds counts, while it is valid", () => {
  const o = { today: TODAY, reasonCodes: REASONS };
  const record = {
    customerType: "retailer",
    monthlyLitres: 1000,
    competitor: "Ashoka",
    requiredProductId: "prd_1",
    contactPerson: "Mr Gupta",
    nextAction: "Call back",
    nextActionDate: "2026-10-01",
  };

  test("a complete record needs only the reason", () => {
    const { merged, write } = mergeProspectAnswers(record, { reasonCode: "regular_requirement" }, o);
    assert.deepEqual(write, { reasonCode: "regular_requirement" });
    assert.deepEqual(prospectAnswerFaults(merged, { ...o, requireFutureDate: false }), []);
  });

  test("a valid record value is never replaced by a supplied one", () => {
    const { merged, write } = mergeProspectAnswers(record, { competitor: "Asian Paints", monthlyLitres: 5, reasonCode: "regular_requirement" }, o);
    assert.equal(merged.competitor, "Ashoka");
    assert.equal(merged.monthlyLitres, 1000);
    assert.equal(write.competitor, undefined);
    assert.equal(write.monthlyLitres, undefined);
  });

  test("an INVALID record value yields to the supplied one", () => {
    const { merged, write } = mergeProspectAnswers({ ...record, monthlyLitres: 0, competitor: "x" }, { monthlyLitres: 300, competitor: "Berger", reasonCode: "regular_requirement" }, o);
    assert.equal(merged.monthlyLitres, 300);
    assert.equal(merged.competitor, "Berger");
    assert.equal(write.competitor, "Berger");
  });

  test("an invalid record value with nothing supplied stays a fault", () => {
    const { merged } = mergeProspectAnswers({ ...record, monthlyLitres: 0 }, { reasonCode: "regular_requirement" }, o);
    assert.equal(prospectAnswerFaults(merged, { ...o, requireFutureDate: false })[0]?.field, "monthlyLitres");
  });

  test("the next step is decided as a pair: half a pair does not count", () => {
    const half = mergeProspectAnswers({ ...record, nextActionDate: null }, { nextAction: "Visit", nextActionDate: "2026-11-05", reasonCode: "regular_requirement" }, o);
    assert.equal(half.merged.nextAction, "Visit");
    assert.equal(half.merged.nextActionDate, "2026-11-05");
    const none = mergeProspectAnswers({ ...record, nextActionDate: null }, { reasonCode: "regular_requirement" }, o);
    assert.equal(prospectAnswerFaults(none.merged, { ...o, requireFutureDate: false })[0]?.field, "nextActionDate");
  });

  test("the reason is never read off the record", () => {
    const { merged } = mergeProspectAnswers({ ...record, reasonCode: "regular_requirement" } as never, {}, o);
    assert.equal(merged.reasonCode, null);
  });

});

describe("a next-step day must be a real calendar day", () => {
  test("accepts real days only", () => {
    const day = (d: string) => faults(complete({ nextActionDate: d }), false).length === 0;
    assert.equal(day("2026-10-24"), true);
    assert.equal(day("2028-02-29"), true);
    assert.equal(day("2026-02-29"), false);
    assert.equal(day("2026-13-01"), false);
    assert.equal(day("24-10-2026"), false);
  });
});
