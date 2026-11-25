/**
 * A Purchase record's flow (`record-flow.ts`): the steps, the Next step card
 * and the history every Purchase pop-up draws, pure.
 *
 *   npm run test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { billRecord, labelRecord, poRecord, PO_STEPS, receiptRecord, testRecord } from "./record-flow";

const at = new Date("2026-11-18T04:34:00Z"); // 18 Nov, 10:04 am IST
const po = (status: string, more: Partial<Parameters<typeof poRecord>[0]["po"]> = {}) => ({
  po: { status, createdAt: at, approvedAt: null, sentAt: null, sentVia: null, closedAt: null, closeReason: null, decisionNote: null, ...more },
  by: "Vikram Rao",
  approver: "Deepa Nair",
});

test("a PO waits on its approver, then on sharing, then on the gate; a received PO has no card", () => {
  const pending = poRecord(po("Pending approval"), "0 of 10", null);
  assert.deepEqual(pending.steps, PO_STEPS);
  assert.equal(pending.step, 1);
  assert.equal(pending.next, "Approve the PO");
  assert.equal(pending.history!.at(-1)!.open, true, "the step still waiting is the last, open entry");

  assert.equal(poRecord(po("Approved", { approvedAt: at }), "0 of 10", null).next, "Share the PO with the supplier");
  const sent = poRecord(po("Sent", { approvedAt: at, sentAt: at, sentVia: "WhatsApp" }), "0 of 10", "WhatsApp · 18 Nov");
  assert.equal(sent.step, 3);
  assert.equal(sent.next, "Receive the goods at the gate");
  assert.match(sent.nextSub!, /Received 0 of 10/);
  assert.ok(sent.history!.some((h) => h.text === "Shared with the supplier on WhatsApp"));
  assert.match(sent.history![1].text, /^Approved by Deepa Nair/);

  const done = poRecord(po("Received", { approvedAt: at, sentAt: at }), "10 of 10", null);
  assert.equal(done.step, PO_STEPS.length);
  assert.equal(done.next, undefined, "nothing left to wait on");
  assert.ok(!done.history!.some((h) => h.open));
});

test("a cancelled PO is a stopped flow; a sent-back one waits on its correction", () => {
  const c = poRecord(po("Cancelled", { closedAt: at, closeReason: "Supplier out of stock" }), "—", null);
  assert.equal(c.step, -1);
  assert.equal(c.next, undefined);
  assert.equal(c.history!.at(-1)!.text, "Cancelled — Supplier out of stock");
  const r = poRecord(po("Rejected", { approvedAt: at, decisionNote: "Rate too high" }), "—", null);
  assert.equal(r.next, "Correct the PO and send it again");
  assert.equal(r.nextSub, "Sent back: Rate too high");
  assert.match(r.history![1].text, /^Sent back by Deepa Nair — Rate too high/);
});

test("a receipt line waits to be sent on, to wherever it goes; once sent it is done", () => {
  const waiting = receiptRecord({ routed: null, routedAt: null, testingRequired: true, createdAt: at }, "Suresh");
  assert.deepEqual(waiting.steps, ["Received at the gate", "Sent to Lot testing"]);
  assert.equal(waiting.step, 1);
  assert.equal(waiting.next, "Send it to Lot testing");
  assert.equal(waiting.history![0].text, "Received at the gate by Suresh");
  /* Where it actually went wins over where its material would go. */
  const billed = receiptRecord({ routed: "Purchase", routedAt: at, testingRequired: true, createdAt: at }, null);
  assert.equal(billed.steps![1], "Sent to Bills");
  assert.equal(billed.step, 2);
  assert.equal(billed.next, undefined);
});

test("a lot to test waits on its test, then its evidence, then the verifier; failed is stopped", () => {
  const toTest = testRecord({ arrived: at, tests: ["Smell", "Density"] });
  assert.equal(toTest.step, 1);
  assert.equal(toTest.next, "Record the test");
  assert.equal(toTest.nextSub, "Tests: Smell, Density");
  const recorded = { at, by: "Anil" };
  assert.equal(testRecord({ arrived: at, tests: [], recorded, bucket: "toVerify", missing: ["Density photo"] }).next, "Record the missing evidence");
  const verify = testRecord({ arrived: at, tests: [], recorded, bucket: "toVerify", missing: [], verifier: false });
  assert.equal(verify.next, "Verify the test");
  assert.match(verify.nextSub!, /the verifier decides/);
  const ok = testRecord({ arrived: at, tests: [], recorded, bucket: "verified", decidedAt: at });
  assert.equal(ok.step, 3);
  assert.equal(ok.next, undefined);
  const no = testRecord({ arrived: at, tests: [], recorded, bucket: "failed", decidedAt: at });
  assert.equal(no.step, -1);
  assert.equal(no.history!.at(-1)!.text, "Marked not verified");
});

test("a lot on Bills waits on its rate first, then the bill, the match and the verification", () => {
  const base = { testId: "t1", ratePaise: null, billNumber: null, createdAt: at };
  const noRate = billRecord(base, "Tested", "Vikram");
  assert.equal(noRate.steps![0], "Tested", "a tested lot's first step says so");
  assert.equal(noRate.next, "Enter the purchase rate");
  assert.equal(billRecord({ ...base, ratePaise: 11800 }, "Tested", null).next, "Record the supplier's bill");
  const billed = billRecord({ ...base, ratePaise: 11800, billNumber: "INV-42" }, "Bill received", null);
  assert.equal(billed.step, 2);
  assert.match(billed.nextSub!, /INV-42/);
  assert.equal(billRecord({ ...base, ratePaise: 11800 }, "Matched", null).next, "Verify the purchase");
  const done = billRecord({ ...base, ratePaise: 11800 }, "Verified", null);
  assert.equal(done.step, 4);
  assert.equal(done.next, undefined);
  assert.equal(billRecord({ ...base, testId: null }, "Arrived", null).steps![0], "Arrived");
});

test("a lot's drum labels: never printed waits on the print; every print and reprint is its history", () => {
  const never = labelRecord(at, "Vikram", 4, []);
  assert.equal(never.step, 1);
  assert.equal(never.next, "Print the drum labels");
  assert.equal(never.nextSub, "4 labels · one for every drum");
  const printed = labelRecord(at, null, 4, [
    { at, by: "Suresh", copies: 4, reprint: false },
    { at, by: "Anil", copies: 1, reprint: true },
  ]);
  assert.equal(printed.step, 2);
  assert.equal(printed.next, undefined);
  assert.deepEqual(printed.history!.map((h) => h.text), ["Lot made", "Printed 4 labels by Suresh", "Reprinted 1 label by Anil"]);
});

test("each card names the row action its button runs", () => {
  assert.equal(poRecord(po("Pending approval"), "0 of 1", null).act, "approve");
  assert.equal(poRecord(po("Approved"), "0 of 1", null).act, "share");
  assert.equal(poRecord(po("Partly received"), "1 of 2", null).act, "receive");
  const base = { testId: null, ratePaise: 100, billNumber: null, createdAt: at };
  assert.equal(billRecord({ ...base, ratePaise: null }, "Arrived", null).act, "rate");
  assert.equal(billRecord(base, "Arrived", null).act, "billReceived");
  assert.equal(billRecord(base, "Bill received", null).act, "status");
});
