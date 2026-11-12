import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkCopyText, fillPlaceholders, pickOption } from "./copy";

const codes = (text: string, lang: "en" | "hi" | "gu" | "mr" = "en", max?: number) => checkCopyText(text, lang, max).map((i) => i.code);

describe("wording guardrails", () => {
  test("approved-style wording passes in every script", () => {
    assert.deepEqual(codes("Wishing you and your team at {company} a prosperous and joyful Diwali."), []);
    assert.deepEqual(codes("आपको और {company} की पूरी टीम को दीपावली की हार्दिक शुभकामनाएँ।", "hi"), []);
    assert.deepEqual(codes("આપને અને {company} ની આખી ટીમને દિવાળીની શુભકામનાઓ.", "gu"), []);
    assert.deepEqual(codes("आपणास आणि {company} मधील सर्व सहकाऱ्यांना शुभेच्छा!", "mr"), []);
  });
  test("placeholders other than {company}, {contact}, {product} are refused", () => {
    assert.deepEqual(codes("Hello {name}"), ["placeholder"]);
    assert.deepEqual(codes("Hello {company"), ["placeholder"]);
  });
  test("digits (Latin or Indic), currency, percentages, links and phone numbers are refused", () => {
    assert.ok(codes("Happy 2027").includes("digits"));
    assert.ok(codes("२०२७ की शुभकामनाएँ", "hi").includes("digits"));
    assert.ok(codes("Only ₹ now").includes("currency"));
    assert.ok(codes("Only Rs. now").includes("currency"));
    assert.ok(codes("Big percent change").includes("percent"));
    assert.ok(codes("Visit www.mahek.com").includes("url"));
    assert.ok(codes("Mail us at hi@mahek.in").includes("url"));
  });
  test("prices, offers and claims are refused", () => {
    for (const bad of ["A special discount for you", "Our best offer", "Free delivery", "Guaranteed quality", "Lowest price in town"]) {
      assert.ok(codes(bad).includes("claim"), bad);
    }
  });
  test("the script must match the language", () => {
    assert.ok(codes("Hello team", "hi").includes("script"));
    assert.ok(codes("नमस्ते", "en").includes("script"));
    assert.ok(codes("નમસ્તે", "hi").includes("script"));
    assert.ok(codes("नमस्ते", "gu").includes("script"));
  });
  test("length is counted in characters, not code units, against the field limit", () => {
    assert.deepEqual(codes("a".repeat(10), "en", 10), []);
    assert.deepEqual(codes("a".repeat(11), "en", 10), ["length"]);
    assert.deepEqual(codes("शुभ".repeat(5), "hi", 15), []);
  });
  test("empty wording is refused", () => {
    assert.ok(codes("   ").includes("empty"));
  });
  test("a plain 'Mahek' mixed into Hindi wording is fine", () => {
    assert.deepEqual(codes("Mahek का {product} आपके सामने है।", "hi"), []);
  });
});

describe("placeholders and the default wording", () => {
  const values = { company: "ABC Industries", contact: "Rajesh Shah", product: "M1433 Thinner" };
  test("fills {company}, {contact} (first name) and {product}", () => {
    assert.equal(fillPlaceholders("{contact}, sharing {product} with {company}.", values), "Rajesh, sharing M1433 Thinner with ABC Industries.");
  });
  test("without a contact, {contact} is the company; without a product, {product} is 'our range'", () => {
    assert.equal(fillPlaceholders("Hi {contact}, {product}", { company: "ABC", contact: null, product: null }), "Hi ABC, our range");
  });
  test("replacement text is plain text: braces and special characters in data are not reinterpreted", () => {
    assert.equal(fillPlaceholders("Hello {company}", { company: "{contact} & <b>Co</b> $&", contact: "x", product: null }), "Hello {contact} & <b>Co</b> $&");
  });
  test("pickOption returns the asked option, or the first one when the id is unknown or missing", () => {
    const options = [
      { id: "formal", label: "Professional", text: "a" },
      { id: "warm", label: "Warm", text: "b" },
    ];
    assert.equal(pickOption(options, "warm")?.id, "warm");
    assert.equal(pickOption(options, "nope")?.id, "formal");
    assert.equal(pickOption(options, undefined)?.id, "formal");
    assert.equal(pickOption([], "warm"), null);
  });
});
