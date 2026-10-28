import test from "node:test";
import assert from "node:assert/strict";
import { lastAnswer, lastFinding, type HistoryCall } from "@/lib/verification-history";

const call = (day: string, answers: Record<string, string>, corrections: HistoryCall["corrections"] = []): HistoryCall => ({
  calledAt: `2026-10-${day}T10:00:00Z`,
  answers,
  corrections,
});

test("a question blank on the newest call is remembered from the one before", () => {
  const calls = [call("20", {}), call("10", { price_issue: "Too high" })];
  assert.deepEqual(lastAnswer(calls, "price_issue"), { text: "Too high", at: "2026-10-10T10:00:00Z" });
});

test("the newest answer wins when several calls answered", () => {
  const calls = [call("20", { price_issue: "Fine now" }), call("10", { price_issue: "Too high" })];
  assert.equal(lastAnswer(calls, "price_issue")?.text, "Fine now");
});

test("nothing remembered when nobody answered", () => {
  assert.equal(lastAnswer([call("20", {})], "price_issue"), null);
});

test("a finding is remembered as confirmed, corrected or unable to verify", () => {
  const f = { id: "contact_person", lands: null };
  assert.equal(lastFinding([call("20", {}, [{ field: "contact_person", verdict: "confirmed" }])], f)?.text, "Confirmed");
  assert.equal(
    lastFinding([call("20", {}, [{ field: "contact_person", verdict: "corrected", corrected: "Anil" }])], f)?.text,
    "Corrected to “Anil”",
  );
  assert.equal(
    lastFinding([call("20", {}, [{ field: "contact_person", verdict: "unverified", reason: "Owner away" }])], f)?.text,
    "Could not verify — Owner away",
  );
});

test("a finding with a column falls back to the column where the call has no check row", () => {
  const f = { id: "competitor", lands: "competitor" };
  assert.equal(lastFinding([call("20", { competitor: "Berger" })], f)?.text, "Berger");
  /* a check row on a newer call outranks an older call's column */
  const newer = call("22", {}, [{ field: "competitor", verdict: "confirmed" }]);
  assert.equal(lastFinding([newer, call("20", { competitor: "Berger" })], f)?.text, "Confirmed");
});

test("a finding unanswered on the newest call is remembered from an older one", () => {
  const f = { id: "decision_maker", lands: null };
  const calls = [call("22", {}), call("10", {}, [{ field: "decision_maker", verdict: "confirmed" }])];
  assert.equal(lastFinding(calls, f)?.at, "2026-10-10T10:00:00Z");
});

test("'Could that grow?' is never remembered, whatever the call looks like", () => {
  const legacy = call("10", { potential: "₹1,80,000" });
  const modern = call("20", { potential: "Could double in season" }, [{ field: "competitor", verdict: "confirmed" }]);
  const unstructured = call("22", { potential: "Could double" });
  assert.equal(lastAnswer([legacy], "potential"), null);
  assert.equal(lastAnswer([modern, legacy], "potential"), null);
  assert.equal(lastAnswer([unstructured], "potential"), null);
});

test("only that one question is held back; every other legacy answer is shown as stored", () => {
  assert.equal(lastAnswer([call("10", { price_issue: "Too high" })], "price_issue")?.text, "Too high");
});
