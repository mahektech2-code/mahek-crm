import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyOverrides, hasOverrides, mergeOverrides, overrideTextProblem, parseOverrides, OVERRIDE_MAX } from "./poster-overrides";
import type { Product } from "./product";
import type { User } from "./lead";
import type { Recipient } from "./recipient";

const PRODUCTS: Product[] = [{ id: "M1433", code: "M1433", name: "M1433 Thinner" }, { id: "M2210", code: "M2210", name: "M2210 Epoxy Primer" }];
const recipient: Recipient = { contact: "Rajesh Shah", company: "ABC Industries", city: "Mumbai", state: "Maharashtra", product: null };
const user: User = { id: "u1", name: "Priya", role: "Team member", initials: "P", displayName: "Priya Nair" };

describe("overrideTextProblem", () => {
  test("plain names and companies, in any script, are fine", () => {
    for (const ok of ["Rajesh Shah", "Dr. A. K. Rao", "O'Brien & Sons", "3M India", "सुनीता देशमुख", "રમેશ ગોકળે", "Zoë Müller", "R. K. (Paints)"]) assert.equal(overrideTextProblem(ok, 100), null, ok);
  });
  test("a phone number, a link, an email, a price or a percentage never goes on a poster", () => {
    const cases: [string, RegExp][] = [["Call +91 98765 43210", /phone/], ["9876543210", /phone/], ["98765-43210", /phone/], ["+1 555", /phone/], ["see www.mahek.com", /link/], ["https://x.in", /link/], ["a@b.in", /link/], ["mahek.com", /link/], ["Only ₹499", /price/], ["20% off", /price/], ["Rs. 50", /price/], ["USD 5", /price/]];
    for (const [text, why] of cases) assert.match(overrideTextProblem(text, 100) ?? "", why, text);
  });
  test("markup, braces, backslashes and control characters are refused", () => {
    for (const bad of ["<b>x</b>", "a{company}", "a}b", "a\\b", "a\u0000b", "a\nb", "a\u0007b"]) assert.match(overrideTextProblem(bad, 100) ?? "", /not allowed/, JSON.stringify(bad));
  });
  test("empty, blank and too long are refused, counting characters not bytes", () => {
    assert.equal(overrideTextProblem("", 10), "cannot be empty");
    assert.equal(overrideTextProblem("   ", 10), "cannot be empty");
    assert.match(overrideTextProblem("x".repeat(11), 10) ?? "", /too long \(at most 10/);
    assert.equal(overrideTextProblem("न".repeat(10), 10), null);
    assert.equal(overrideTextProblem("x".repeat(OVERRIDE_MAX.name), OVERRIDE_MAX.name), null);
  });
});

describe("parseOverrides", () => {
  test("a good set is kept and tidied; nothing is invented", () => {
    const r = parseOverrides({ name: "  Rajesh   Shah ", company: "ABC Industries", productCode: "M1433", salesperson: "Priya Nair", variantId: "warm" });
    assert.deepEqual(r.ok && r.data, { name: "Rajesh Shah", company: "ABC Industries", productCode: "M1433", salesperson: "Priya Nair", variantId: "warm" });
    assert.deepEqual(parseOverrides(undefined), { ok: true, data: {} });
    assert.deepEqual(parseOverrides({}), { ok: true, data: {} });
  });
  test("a bad value is refused with the field named, in plain words", () => {
    const bad = parseOverrides({ name: "Call 9876543210" });
    assert.ok(!bad.ok);
    assert.equal(bad.error, "Name cannot contain a phone number.");
    assert.deepEqual(bad.fieldErrors, { name: "cannot contain a phone number" });
    assert.equal((parseOverrides({ company: "" }) as { error: string }).error, "Company cannot be empty.");
  });
  test("a product or wording choice must look like a choice, not like text", () => {
    for (const code of ["M 1433", "../x", "x".repeat(41), "", "<b>"]) assert.ok(!parseOverrides({ productCode: code }).ok, code);
    for (const id of ["Warm", "a b", "1x", "", "x".repeat(81)]) assert.ok(!parseOverrides({ variantId: id }).ok, id);
  });
  test("fields that cannot be edited, wrong types and non-objects are refused", () => {
    for (const raw of [{ city: "Pune" }, { phone: "+919876543210" }, { template: "x" }, { name: 5 }, { name: null }, "name", [], 7]) assert.ok(!parseOverrides(raw).ok, JSON.stringify(raw));
  });
});

describe("mergeOverrides and hasOverrides", () => {
  test("an edit for one recipient wins over the edit for everyone, field by field", () => {
    assert.deepEqual(mergeOverrides({ salesperson: "A", company: "Common Co" }, { company: "Own Co", name: "Own Name" }), { salesperson: "A", company: "Own Co", name: "Own Name" });
    assert.deepEqual(mergeOverrides(null, undefined), {});
    assert.deepEqual(mergeOverrides({ name: "x" }, null), { name: "x" });
  });
  test("has overrides only when something is set", () => {
    assert.equal(hasOverrides({}), false);
    assert.equal(hasOverrides(null), false);
    assert.equal(hasOverrides({ variantId: "warm" }), true);
  });
});

describe("applyOverrides", () => {
  test("puts the edits on top of the record, in new objects, leaving the originals alone", () => {
    const before = JSON.stringify([recipient, user]);
    const r = applyOverrides({ recipient, user, variantId: undefined }, { name: "Raj", company: "New Co", productCode: "M2210", salesperson: "Sam", variantId: "warm" }, PRODUCTS);
    assert.ok(r.ok);
    assert.deepEqual([r.data.recipient.contact, r.data.recipient.company, r.data.recipient.product?.code, r.data.user.displayName, r.data.variantId], ["Raj", "New Co", "M2210", "Sam", "warm"]);
    assert.equal(r.data.recipient.city, "Mumbai");
    assert.equal(JSON.stringify([recipient, user]), before, "the record and the user are untouched");
  });
  test("no edits changes nothing, and a batch wording is kept unless an edit chooses another", () => {
    const r = applyOverrides({ recipient, user, variantId: "common-wording" }, undefined, PRODUCTS);
    assert.ok(r.ok);
    assert.deepEqual([r.data.recipient, r.data.user, r.data.variantId], [recipient, user, "common-wording"]);
    const own = applyOverrides({ recipient, user, variantId: "common-wording" }, { variantId: "own" }, PRODUCTS);
    assert.ok(own.ok && own.data.variantId === "own");
  });
  test("a product that is not one of the approved choices is refused", () => {
    const r = applyOverrides({ recipient, user, variantId: undefined }, { productCode: "M9999" }, PRODUCTS);
    assert.ok(!r.ok);
    assert.equal(r.error, "That product is not one of the approved choices.");
    assert.ok(!applyOverrides({ recipient, user, variantId: undefined }, { productCode: "M1433" }, []).ok, "with no approved products nothing can be chosen");
  });
  test("a recipient with no contact is greeted by the name that was typed", () => {
    const r = applyOverrides({ recipient: { ...recipient, contact: null }, user, variantId: undefined }, { name: "Mr Shah" }, PRODUCTS);
    assert.ok(r.ok && r.data.recipient.contact === "Mr Shah");
  });
});
