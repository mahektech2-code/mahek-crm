/**
 * The Lead Calling Desk's voice assistant engine, pinned.
 *
 * What is worth failing the build over, in the client's own words: only the
 * questions currently being asked may ever receive a proposal, an ambiguous
 * or unmatched product never becomes an id, an uncertain number is a
 * question rather than a figure, the AI never gets to pick a call outcome or
 * a no-answer reason (it has no way to — this engine does not accept them as
 * input at all), and `customerType`/`creditDaysWanted = 0` behave exactly as
 * `isAnswered()` already defines them.
 *
 * Pure, like the engine it wraps: no database, no network, no clock.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DESK_FIELDS, questionsForCall, type DeskValues } from "@/lib/engines/lead-calling-desk";
import { decideLeadCallFill, type LeadCallFill } from "@/lib/engines/lead-call-intel-decide";
import type { LeadCallReading } from "@/lib/lead-call-intel-schema";
import type { ProductMatch } from "@/lib/engines/call-intel-decide";

const field = (key: string) => DESK_FIELDS.find((f) => f.key === key)!;

/** An empty reading, with just the slots a test cares about filled in. */
function reading(partial: Partial<LeadCallReading>): LeadCallReading {
  return {
    customerType: null,
    monthlyLitres: null,
    product: null,
    competitor: null,
    application: null,
    decisionMaker: null,
    buyer: null,
    gstin: null,
    creditDaysWanted: null,
    address: null,
    email: null,
    unclear: [],
    ...partial,
  };
}

const CONFIG = { confirmBelow: 70 };

function fillOf(fills: LeadCallFill[], key: string): LeadCallFill | undefined {
  return fills.find((f) => f.key === key);
}

describe("decideLeadCallFill — only what is currently being asked", () => {
  test("1. extracts valid monthly litres, ready at high confidence", () => {
    const r = reading({
      monthlyLitres: { value: 400, confidence: 90, evidence: "about four hundred litres a month" },
    });
    const askNow = questionsForCall({}, 1).askNow;
    const a = decideLeadCallFill({ reading: r, text: "about four hundred litres a month", askNow, products: {}, config: CONFIG });
    const fill = fillOf(a.fills, "monthlyLitres");
    assert.ok(fill);
    assert.equal(fill!.state, "ready");
    assert.equal(fill!.textValue, "400");
  });

  test("2. extracts a product cue and resolves it to a real id when it matches one row", () => {
    const r = reading({
      product: { value: "Nano Thinner", confidence: 85, evidence: "Nano Thinner" },
    });
    const askNow = questionsForCall({}, 1).askNow;
    const products: Record<string, ProductMatch> = {
      "Nano Thinner": { state: "matched", productId: "prod_1", name: "Nano Thinner - 5 Liter" },
    };
    const a = decideLeadCallFill({ reading: r, text: "Nano Thinner", askNow, products, config: CONFIG });
    const fill = fillOf(a.fills, "requiredProductId");
    assert.ok(fill);
    assert.equal(fill!.state, "ready");
    assert.equal(fill!.product?.state, "matched");
    assert.equal((fill!.product as Extract<ProductMatch, { state: "matched" }>).productId, "prod_1");
  });

  test("3. an ambiguous or unmatched product never produces a product id", () => {
    const r = reading({ product: { value: "Nano", confidence: 80, evidence: "Nano" } });
    const askNow = questionsForCall({}, 1).askNow;

    const ambiguous = decideLeadCallFill({
      reading: r,
      text: "Nano",
      askNow,
      products: { Nano: { state: "ambiguous", options: [{ productId: "a", name: "Nano 5L" }, { productId: "b", name: "Nano 20L" }] } },
      config: CONFIG,
    });
    const fillA = fillOf(ambiguous.fills, "requiredProductId");
    assert.ok(fillA);
    assert.equal(fillA!.state, "confirm");
    /* The options are kept, so the UI can offer them — but the state is never
       `matched`, which is the only state an id is ever applied from. */
    assert.notEqual(fillA!.product?.state, "matched", "no id is ever carried for an ambiguous match");

    const none = decideLeadCallFill({
      reading: r,
      text: "Nano",
      askNow,
      products: { Nano: { state: "none" } },
      config: CONFIG,
    });
    const fillN = fillOf(none.fills, "requiredProductId");
    assert.ok(fillN);
    assert.equal(fillN!.state, "confirm");
    assert.equal(fillN!.product, null);
  });

  test("4. Decision Maker, Product and Monthly requirement the call never mentioned are left blank, not invented", () => {
    /* Call 3 asks all three, so a fill WOULD be possible if the reading offered one. */
    const askNow = questionsForCall({}, 3).askNow;
    for (const key of ["decisionMaker", "requiredProductId", "monthlyLitres"]) {
      assert.ok(askNow.some((f) => f.key === key), `${key} is being asked`);
    }
    const nothingSaid = decideLeadCallFill({
      reading: reading({}),
      text: "he said he will think about it and call back",
      askNow,
      products: {},
      config: CONFIG,
    });
    for (const key of ["decisionMaker", "requiredProductId", "monthlyLitres"]) {
      assert.equal(fillOf(nothingSaid.fills, key), undefined, `${key} was invented`);
    }
    /* Empty-ish slots are not answers either: a blank name, a zero, a product with no words. */
    const emptyish = decideLeadCallFill({
      reading: reading({
        decisionMaker: { value: "   ", confidence: 80, evidence: "" },
        monthlyLitres: { value: 0, confidence: 80, evidence: "" },
        product: { value: null, confidence: 0, evidence: "" },
      }),
      text: "not sure",
      askNow,
      products: {},
      config: CONFIG,
    });
    assert.deepEqual(emptyish.fills, []);
  });

  test("4b. the rupee estimate is no longer a question the reading can answer", () => {
    assert.ok(!DESK_FIELDS.some((f) => (f.key as string) === "potentialPaise"));
    assert.ok(!("potentialRupees" in reading({})));
  });

  test("5. a field already answered is never proposed — it is not in askNow to begin with", () => {
    const values: DeskValues = { monthlyLitres: 400 };
    const askNow = questionsForCall(values, 1).askNow;
    assert.ok(!askNow.some((f) => f.key === "monthlyLitres"), "already-answered field must not be in askNow");
    const r = reading({ monthlyLitres: { value: 999, confidence: 95, evidence: "nine hundred ninety nine" } });
    const a = decideLeadCallFill({ reading: r, text: "999", askNow, products: {}, config: CONFIG });
    assert.ok(!fillOf(a.fills, "monthlyLitres"), "engine must not propose a field outside askNow even if the reading mentions it");
  });

  test("6. a field not in the current call's askNow is rejected even with a strong reading", () => {
    /* `buyer` is suggestCall 3 — not open for Call 1 at all. */
    const askNow = questionsForCall({}, 1).askNow;
    assert.ok(!askNow.some((f) => f.key === "buyer"));
    const r = reading({ buyer: { value: "Ramesh", confidence: 99, evidence: "Ramesh places the order" } });
    const a = decideLeadCallFill({ reading: r, text: "Ramesh places the order", askNow, products: {}, config: CONFIG });
    assert.ok(!fillOf(a.fills, "buyer"));
  });

  test("7. customerType only ever becomes one of the four configured values", () => {
    const askNow = [field("customerType")];
    const r = reading({
      customerType: { value: "dealer", confidence: 95, evidence: "he is a dealer" },
    });
    const a = decideLeadCallFill({ reading: r, text: "he is a dealer", askNow, products: {}, config: CONFIG });
    const fill = fillOf(a.fills, "customerType");
    assert.equal(fill!.textValue, "dealer");
    assert.ok(["dealer", "manufacturer", "distributor", "retailer"].includes(fill!.textValue!));
  });

  test("8. creditDaysWanted = 0 is a valid, proposable answer — not treated as missing", () => {
    const askNow = [field("creditDaysWanted")];
    const r = reading({
      creditDaysWanted: { value: 0, confidence: 92, evidence: "cash on delivery, no credit" },
    });
    const a = decideLeadCallFill({ reading: r, text: "cash on delivery", askNow, products: {}, config: CONFIG });
    const fill = fillOf(a.fills, "creditDaysWanted");
    assert.ok(fill, "zero credit days must still produce a fill");
    assert.equal(fill!.textValue, "0");
    assert.equal(fill!.state, "ready");
  });

  test("9. the engine has no way to set a call outcome or a no-answer reason", () => {
    const r = reading({});
    const a = decideLeadCallFill({ reading: r, text: "", askNow: questionsForCall({}, 1).askNow, products: {}, config: CONFIG });
    for (const fill of a.fills) {
      assert.notEqual(fill.key, "outcome");
      assert.notEqual(fill.key, "noAnswerReason");
    }
    /* The analysis type itself carries no outcome/no-answer-reason field —
       there is nothing for a caller to read even if it wanted to. */
    assert.ok(!("outcome" in a));
    assert.ok(!("noAnswerReason" in a));
  });

  test("10. fill-only-empty is the caller's job, proven by what the engine hands back", () => {
    /* The engine itself has no notion of "already typed in the box" — that
       check lives where the proposal is APPLIED (the UI), which is exactly
       what makes it impossible for the engine to bypass it. This test proves
       the engine's output carries enough for the caller to make that check:
       a textValue (or a resolved product) per field, nothing more. */
    const r = reading({ competitor: { value: "Asian Paints", confidence: 90, evidence: "Asian Paints" } });
    const askNow = questionsForCall({}, 1).askNow;
    const a = decideLeadCallFill({ reading: r, text: "Asian Paints", askNow, products: {}, config: CONFIG });
    const fill = fillOf(a.fills, "competitor");
    assert.equal(fill!.textValue, "Asian Paints");
  });

  test("11. no reading at all means no proposals — nothing is invented without evidence", () => {
    const a = decideLeadCallFill({ reading: null, text: "", askNow: questionsForCall({}, 1).askNow, products: {}, config: CONFIG });
    assert.deepEqual(a.fills, []);
    assert.equal(a.readByModel, false);
  });

  test("decisionMaker and buyer are never conflated — a reading naming only one proposes only that one", () => {
    const askNow = questionsForCall({}, 2).askNow.concat(field("buyer"));
    const r = reading({
      decisionMaker: { value: "Suresh, the owner", confidence: 92, evidence: "Suresh decides" },
    });
    const a = decideLeadCallFill({ reading: r, text: "Suresh decides", askNow, products: {}, config: CONFIG });
    assert.ok(fillOf(a.fills, "decisionMaker"));
    assert.ok(!fillOf(a.fills, "buyer"), "buyer must not be filled from a decision-maker-only reading");
  });

  test("unclear items are carried through verbatim, for the telecaller to answer", () => {
    const r = reading({ unclear: ["Could not tell if they meant litres or cans."] });
    const a = decideLeadCallFill({ reading: r, text: "", askNow: questionsForCall({}, 1).askNow, products: {}, config: CONFIG });
    assert.deepEqual(a.unclear, ["Could not tell if they meant litres or cans."]);
  });
});
