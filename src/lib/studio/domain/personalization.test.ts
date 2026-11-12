import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyPersonalization, cleanDraft, hasPersonalization, messageScriptProblem, parsePersonalization, phoneProblem, textProblem } from "./personalization";

const record = { contact: "Asha Shah", company: "Alpha Paints", city: "Rajkot", state: "Gujarat", product: null };

describe("poster-only edits: what is accepted", () => {
  test("name, company, message and phone are tidied and accepted", () => {
    const r = parsePersonalization({ name: "  Asha   Shah ", company: "Alpha Paints", message: "Wishing you a bright and joyful Diwali", phone: " +91 98765 43210 " });
    assert.ok(r.ok);
    assert.deepEqual(r.data, { name: "Asha Shah", company: "Alpha Paints", message: "Wishing you a bright and joyful Diwali", phone: "+91 98765 43210" });
  });
  test("an empty field is not an edit; nothing at all is no edit", () => {
    const r = parsePersonalization({ name: "", company: "   ", message: "", phone: "" });
    assert.ok(r.ok);
    assert.deepEqual(r.data, {});
    assert.equal(hasPersonalization(r.data), false);
    assert.deepEqual(parsePersonalization(undefined), { ok: true, data: {} });
  });
  test("Hindi and Gujarati text is accepted", () => {
    assert.ok(parsePersonalization({ message: "दीपावली की हार्दिक शुभकामनाएँ" }).ok);
    assert.ok(parsePersonalization({ name: "કિરણ પટેલ" }).ok);
  });
  test("a form draft becomes edits with empty boxes dropped", () => {
    assert.deepEqual(cleanDraft({ name: " Asha ", company: "", message: "  " }), { name: "Asha" });
    assert.deepEqual(cleanDraft(undefined), {});
  });
});

describe("poster-only edits: what is refused, and never echoed", () => {
  const refused: [string, unknown][] = [
    ["a link", { message: "Visit www.example.com today" }],
    ["a web address without www", { message: "Order at shop.example.in" }],
    ["an email address", { message: "Mail me at asha@example.com" }],
    ["a payment link", { message: "Pay now via UPI" }],
    ["markup", { message: "<b>Hello</b>" }],
    ["a script tag", { name: "<script>alert(1)</script>" }],
    ["braces", { message: "Hello {name}" }],
    ["a backslash", { company: "A\\B" }],
    ["a control character", { message: "Hello\u0007there" }],
    ["a line break", { message: "Hello\nthere" }],
    ["an emoji the poster cannot draw", { message: "Happy Diwali 🪔" }],
    ["a price", { message: "Only ₹499 for you" }],
    ["a percentage", { message: "Enjoy 20% more" }],
    ["a discount", { message: "A special discount for you" }],
    ["an offer", { message: "Our best offer ends soon" }],
    ["a guarantee", { message: "Quality guaranteed" }],
    ["a certification", { message: "An ISO certified company" }],
    ["a Hindi offer word", { message: "दिवाली पर खास छूट" }],
    ["a phone number in the message", { message: "Call us on 9876543210" }],
    ["a phone number in the name", { name: "Asha 9876543210" }],
    ["a message that is too long", { message: "a".repeat(201) }],
    ["a name that is too long", { name: "a".repeat(61) }],
    ["an unknown field", { price: "10" }],
    ["a non-text value", { name: 5 }],
  ];
  for (const [label, input] of refused) {
    test(`refuses ${label}`, () => {
      const r = parsePersonalization(input);
      assert.equal(r.ok, false);
      if (!r.ok) {
        const typed = Object.values(input as Record<string, unknown>).map(String);
        for (const t of typed) if (t.length > 3) assert.ok(!r.error.includes(t), "the error never repeats what was typed");
        assert.ok(Object.keys(r.fieldErrors ?? {}).length > 0);
      }
    });
  }
  test("a non-object is refused", () => {
    assert.equal(parsePersonalization("hello").ok, false);
    assert.equal(parsePersonalization(["a"]).ok, false);
  });
  test("a name or company may contain a claim word, because it is a name", () => {
    assert.equal(textProblem("Free Spirit Traders", "company"), null);
    assert.notEqual(textProblem("Free gift for you", "message"), null);
  });
});

describe("the contact number", () => {
  for (const ok of ["9876543210", "+91 98765 43210", "(022) 2345-6789", "+1 415.555.2671"]) test(`accepts ${ok}`, () => assert.equal(phoneProblem(ok), null));
  for (const bad of ["", "12345", "1".repeat(16), "abc", "98765 4321x", "+91+98765", "tel:9876543210", "98765@43210", "<9876543210>", "9876543210\u0000", "९८७६५४३२१०"]) test(`refuses ${JSON.stringify(bad)}`, () => assert.notEqual(phoneProblem(bad), null));
  test("a refused number is never repeated in the error", () => {
    const r = parsePersonalization({ phone: "98765x43210" });
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(!r.error.includes("98765"));
      assert.ok(!JSON.stringify(r.fieldErrors).includes("98765"));
    }
  });
});

describe("script of the message against the design language", () => {
  test("English is always drawable; the language's own script is too; another Indic script is not", () => {
    assert.equal(messageScriptProblem("Happy Diwali", "gu"), null);
    assert.equal(messageScriptProblem("શુભ દિવાળી", "gu"), null);
    assert.notEqual(messageScriptProblem("શુભ દિવાળી", "hi"), null);
    assert.notEqual(messageScriptProblem("शुभ दिवाली", "en"), null);
    assert.equal(messageScriptProblem("शुभ दिवाली", "mr"), null);
  });
});

describe("applying the edits", () => {
  test("a new recipient carries the edits and the record is not changed", () => {
    const before = structuredClone(record);
    const out = applyPersonalization(record, { name: "A. Shah", company: "Alpha Group", message: "Hi", phone: "9876543210" });
    assert.equal(out.contact, "A. Shah");
    assert.equal(out.company, "Alpha Group");
    assert.notEqual(out, record);
    assert.deepEqual(record, before);
    assert.ok(!("phone" in out) && !("message" in out), "the message and number never join the recipient");
  });
  test("no edits leaves the record's own values", () => {
    assert.deepEqual(applyPersonalization(record, {}), record);
    assert.deepEqual(applyPersonalization(record, null), record);
  });
});
