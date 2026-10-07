import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEvidence, findProhibited, locate, redact } from "./guards";

test("redaction strips identity numbers, phones and emails before a model sees them", () => {
  const r = redact("Aadhaar 4417 2231 9087, PAN ABCDE1234F, call 98220 41736 or suresh@example.com, a/c 123456789012");
  assert.doesNotMatch(r.text, /4417|ABCDE1234F|41736|suresh@|123456789012/);
  assert.ok(r.fields.includes("aadhaar") && r.fields.includes("pan") && r.fields.includes("phone") && r.fields.includes("email"));
});

test("a fabricated quote is rejected; a real one resolves, even with curly quotes and spacing", () => {
  const said = "I went with the corrected invoice myself and stayed till he checked every drum.";
  assert.ok(locate(said, "stayed till he checked every drum"));
  assert.ok(locate("He said “the same as last time”,  so I read it back.", 'He said "the same as last time", so I read it back.'));
  assert.equal(locate(said, "I always exceed my targets"), null);
  assert.match(checkEvidence([{ verbatim: "I always exceed my targets", source: "a" }], { a: said }) ?? "", /not in the candidate/);
  assert.equal(checkEvidence([{ verbatim: "corrected invoice myself", source: "a" }], { a: said }), null);
});

test("prohibited inferences are caught in values, never in keys", () => {
  assert.equal(findProhibited({ confidence: 0.9, reasoning: "Names a specific dealer and the result." }), null);
  assert.equal(findProhibited({ reasoning: "He seemed nervous and his accent was strong." }), "emotion");
  assert.equal(findProhibited({ notes: ["Recently married, may not travel."] }), "family");
  assert.equal(findProhibited({ x: "Good body language" }), "accent or demeanour");
});
