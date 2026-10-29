/** The Accounts bypass rules — pure, no database. See `lib/lead-bypass.ts`. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BYPASS_STEP_OF, bypassSchema, funnelPosition, type BypassInput } from "@/lib/lead-bypass";

const base: BypassInput = {
  leadId: "cus_1",
  name: "Shop F",
  contactPerson: "Person F",
  phone: "9811100011",
  customerType: "dealer",
  gstin: "27AAPFU0939F1ZV",
  address: "Plot 12, MIDC",
  city: "Nagpur",
  state: "Maharashtra",
  sales: { kind: "user", userId: "usr_1" },
  creditTermDays: 30,
  priceTag: "MH Dealer",
  freightTerm: "paid",
  deliveryType: "Door Delivery",
  reasonCode: "order_today",
  note: "Ten characters at least.",
  confirm: "convert",
};

const fields = (over: Partial<BypassInput>) => {
  const r = bypassSchema.safeParse({ ...base, ...over });
  return r.success ? [] : r.error.issues.map((i) => String(i.path[0]));
};

describe("bypassSchema", () => {
  test("a complete form passes, CONVERT in any case", () => {
    assert.deepEqual(fields({}), []);
  });

  test("every required answer is refused when empty", () => {
    for (const f of ["name", "contactPerson", "phone", "address", "city", "priceTag", "note"] as const) {
      assert.ok(fields({ [f]: "" }).includes(f), f);
    }
    assert.ok(fields({ sales: { kind: "none" } }).includes("sales"));
    assert.ok(fields({ customerType: "" as never }).includes("customerType"));
    assert.ok(fields({ freightTerm: "" as never }).includes("freightTerm"));
    assert.ok(fields({ deliveryType: "" as never }).includes("deliveryType"));
    assert.ok(fields({ state: "" }).includes("state"));
    assert.ok(fields({ reasonCode: "" }).includes("reasonCode"));
    assert.ok(fields({ confirm: "" }).includes("confirm"));
  });

  test("GSTIN: required, checked, and from the same state — or not registered with a reason", () => {
    assert.ok(fields({ gstin: "" }).includes("gstin"));
    assert.ok(fields({ gstin: "27AAPFU0939F1ZX" }).includes("gstin"));
    assert.ok(fields({ state: "Gujarat" }).includes("state"));
    assert.ok(fields({ gstin: "", gstNotRegistered: true }).includes("gstNotRegisteredReason"));
    assert.deepEqual(fields({ gstin: "", gstNotRegistered: true, gstNotRegisteredReason: "Below limit" }), []);
  });

  test("every field belongs to a step of the dialog", () => {
    for (const key of Object.keys(bypassSchema.shape)) assert.ok(BYPASS_STEP_OF[key], key);
  });
});

describe("funnelPosition", () => {
  test("a direct lead at Qualification has Suspect and Prospect behind it", () => {
    const p = funnelPosition("qualification", "direct");
    assert.deepEqual(p.passed.map((s) => s.stage), ["suspect", "prospect"]);
    assert.equal(p.skipped[0].stage, "qualification");
    assert.ok(p.skipped.some((s) => s.stage === "second_order"));
    assert.ok(!p.skipped.some((s) => s.stage === "customer"), "the landing rung is not skipped");
  });

  test("a legacy lead with no sales type climbs the old ladder", () => {
    const p = funnelPosition("contacted", null);
    assert.deepEqual(p.passed.map((s) => s.stage), ["new"]);
    assert.deepEqual(p.skipped.map((s) => s.stage), ["contacted", "qualified", "negotiation"]);
  });

  test("a lead off its ladder (lost, on hold) skips every working rung", () => {
    const p = funnelPosition("lost", "direct");
    assert.equal(p.passed.length, 0);
    assert.equal(p.skipped[0].stage, "suspect");
  });
});
