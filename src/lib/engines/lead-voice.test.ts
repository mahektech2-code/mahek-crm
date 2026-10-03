import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanVoice, heardAnything, type LeadVoiceContext } from "./lead-voice";
import type { LeadVoiceReadingParsed } from "@/lib/lead-voice-schema";

/* Everything goes through `cleanVoice`, the one function the service calls,
   so a rule tested here is a rule the handset actually receives. */

const CTX: LeadVoiceContext = {
  today: "2026-09-24", // a Thursday
  working: { timezone: "Asia/Kolkata", dayBoundaryHour: 0, workingDays: [1, 2, 3, 4, 5, 6] },
  salesTypes: [
    { code: "direct", label: "Direct customer" },
    { code: "third_party", label: "Third-party shop" },
  ],
  sources: [
    { code: "salesman_prospecting", label: "Salesman Prospecting" },
    { code: "walk_in", label: "Walk-in" },
    { code: "other", label: "Other" },
  ],
  customerTypes: [
    { code: "dealer", label: "Dealer" },
    { code: "manufacturer", label: "Manufacturer" },
  ],
  otherSource: "other",
};

const blank: LeadVoiceReadingParsed = {
  salesType: null,
  businessName: null,
  contactPerson: null,
  phones: [],
  gstin: null,
  city: null,
  state: null,
  address: null,
  source: null,
  sourceDetail: null,
  potentialRupeesPerMonth: null,
  followUp: null,
  customerType: null,
  requirement: null,
  monthlyLitres: null,
  decisionMaker: null,
  competitor: null,
  unclear: [],
};

const cue = (over: Partial<NonNullable<LeadVoiceReadingParsed["followUp"]>>) => ({
  phrase: "",
  kind: "unclear" as const,
  n: null,
  weekday: null,
  which: null,
  day: null,
  month: null,
  date: null,
  ...over,
});

test("a whole description lands in every field it names", () => {
  const r = cleanVoice(
    {
      ...blank,
      salesType: "direct",
      businessName: "Shree Ganesh Furniture Works",
      contactPerson: "Ramesh Patil",
      phones: [{ number: "98220 11001", kind: "mobile" }],
      city: "Nagpur",
      address: "Plot 12, Hingna MIDC",
      source: "salesman_prospecting",
      potentialRupeesPerMonth: 40000,
      followUp: cue({ phrase: "parso", kind: "day_after_tomorrow" }),
      customerType: "manufacturer",
      requirement: "PU lacquer and thinner for furniture",
      monthlyLitres: 200,
      decisionMaker: "His brother, Suresh",
      competitor: "Asian Paints",
    },
    CTX,
  );
  assert.equal(r.salesType, "direct");
  assert.equal(r.businessName, "Shree Ganesh Furniture Works");
  assert.equal(r.contactPerson, "Ramesh Patil");
  assert.equal(r.mobile, "9822011001");
  assert.equal(r.source, "salesman_prospecting");
  assert.equal(r.potentialRupees, 40000);
  assert.equal(r.followUp?.date, "2026-09-26");
  assert.equal(r.customerType, "manufacturer");
  assert.equal(r.monthlyLitres, 200);
  assert.equal(r.competitor, "Asian Paints");
  assert.deepEqual(r.questions, []);
  assert.ok(heardAnything(r));
});

test("a choice not on the office's list is dropped, and a refused source is said", () => {
  const r = cleanVoice({ ...blank, salesType: "wholesale", source: "newspaper", customerType: "contractor" }, CTX);
  assert.equal(r.salesType, null);
  assert.equal(r.source, null);
  assert.equal(r.customerType, null);
  assert.ok(r.questions.some((q) => q.includes("newspaper")));
});

test("a choice given as its label is still the code", () => {
  const r = cleanVoice({ ...blank, source: "Walk-in", customerType: "dealer" }, CTX);
  assert.equal(r.source, "walk_in");
  assert.equal(r.customerType, "dealer");
});

test("'other' carries its detail; any other source drops one", () => {
  assert.equal(cleanVoice({ ...blank, source: "other", sourceDetail: "A painter sent him" }, CTX).sourceDetail, "A painter sent him");
  assert.equal(cleanVoice({ ...blank, source: "walk_in", sourceDetail: "A painter sent him" }, CTX).sourceDetail, null);
});

test("a follow-up is worked out from the cue, never taken from the model", () => {
  /* Sunday is not worked, so "in 3 days" from Thursday moves to Monday. */
  const moved = cleanVoice({ ...blank, followUp: cue({ phrase: "teen din baad", kind: "in_days", n: 3 }) }, CTX);
  assert.equal(moved.followUp?.date, "2026-09-28");
  /* A date that has already gone is asked, not filled. */
  const past = cleanVoice(
    { ...blank, followUp: cue({ phrase: "the 2nd", kind: "absolute", date: "2026-09-02" }) },
    CTX,
  );
  assert.equal(past.followUp?.date, null);
  assert.ok(past.questions.length > 0);
  /* Nothing said, nothing offered. */
  assert.equal(cleanVoice(blank, CTX).followUp, null);
});

test("an amount past any real shop is a mishearing and is left empty", () => {
  const r = cleanVoice({ ...blank, potentialRupeesPerMonth: 4_000_000_000, monthlyLitres: -5 }, CTX);
  assert.equal(r.potentialRupees, null);
  assert.equal(r.monthlyLitres, null);
  assert.ok(r.questions.some((q) => q.includes("misheard")));
});

test("the card scan's number and GSTIN rules apply to speech too", () => {
  const landline = cleanVoice({ ...blank, phones: [{ number: "0712 2554433", kind: "landline" }] }, CTX);
  assert.equal(landline.mobile, null, "an STD number never becomes the mobile");
  assert.ok(landline.questions.some((q) => q.includes("mobile")));

  const gst = cleanVoice({ ...blank, gstin: "27 aapfu 0939 f1zv" }, CTX);
  assert.equal(gst.gstin, "27AAPFU0939F1ZV");
  assert.equal(gst.gstinCheck, "valid");
  assert.equal(gst.state, "Maharashtra", "a valid GSTIN fills an unsaid state");

  const bad = cleanVoice({ ...blank, gstin: "27AAPFU0939F1ZX" }, CTX);
  assert.equal(bad.gstinCheck, "invalid");
  assert.ok(bad.questions.some((q) => q.includes("GST")));
});

test("the shop's name in the person's place is the model filling a box", () => {
  const r = cleanVoice({ ...blank, businessName: "Patil Paints", contactPerson: "patil paints" }, CTX);
  assert.equal(r.contactPerson, null);
});

test("the model's own doubts reach the screen, once each", () => {
  const r = cleanVoice({ ...blank, businessName: "X", unclear: ["Number had nine digits", "Number had nine digits", "N/A"] }, CTX);
  assert.deepEqual(r.questions, ["Number had nine digits"]);
});

test("nothing heard is nothing", () => {
  assert.equal(heardAnything(cleanVoice(blank, CTX)), false);
});
