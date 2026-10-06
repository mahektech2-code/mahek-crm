import { test } from "node:test";
import assert from "node:assert/strict";
import { matchReceipts, receiptStatusOf, watiWaId, wordsKey } from "./wati-receipts";

const at = (iso: string) => new Date(iso);

test("Wati's status words become ticks; failed is left to the webhook", () => {
  assert.equal(receiptStatusOf("READ"), "read");
  assert.equal(receiptStatusOf("Delivered"), "delivered");
  assert.equal(receiptStatusOf("SENT"), "sent");
  assert.equal(receiptStatusOf("FAILED"), null);
  assert.equal(receiptStatusOf(null), null);
});

test("a typed reply matches on Wati's own id, whatever the time", () => {
  const r = matchReceipts(
    [{ id: "wam_1", providerRef: "6ac51f0d", sentAt: at("2026-10-06T16:17:00Z"), body: "anything" }],
    [{ id: "6ac51f0d", eventType: "message", owner: true, statusString: "READ", created: "2026-10-06T18:00:00Z", text: "other" }],
  );
  assert.deepEqual(r, [{ messageId: "wam_1", status: "read" }]);
});

test("a template matches the broadcast sent within minutes with the same opening words", () => {
  const r = matchReceipts(
    [{ id: "wam_t", providerRef: null, sentAt: at("2026-10-06T07:22:20.605Z"), body: "*URGENT PAYMENT FOLLOW-UP – RANUJA ART*\n\nDear Sir" }],
    [
      { id: "x", eventType: "broadcastMessage", statusString: "READ", created: "2026-10-06T07:22:21.254Z", finalText: "*URGENT PAYMENT FOLLOW-UP – RANUJA ART*\n\nDear Sir/Madam" },
      { id: "y", eventType: "broadcastMessage", statusString: "READ", created: "2026-10-02T07:22:14Z", finalText: "*URGENT PAYMENT FOLLOW-UP – RANUJA ART*" },
    ],
  );
  assert.deepEqual(r, [{ messageId: "wam_t", status: "read" }]);
});

test("time alone is not enough — different words do not match", () => {
  const r = matchReceipts(
    [{ id: "wam_t", providerRef: null, sentAt: at("2026-10-06T07:22:20Z"), body: "Payment follow-up for bill 1119" }],
    [{ id: "x", eventType: "broadcastMessage", statusString: "READ", created: "2026-10-06T07:22:21Z", finalText: "Order dispatched today" }],
  );
  assert.deepEqual(r, []);
});

test("the customer's own messages are never our ticks", () => {
  const r = matchReceipts(
    [{ id: "wam_1", providerRef: "abc", sentAt: at("2026-10-06T07:00:00Z"), body: "hello there sir" }],
    [{ id: "abc", eventType: "message", owner: false, statusString: "SENT", created: "2026-10-06T07:00:01Z", text: "hello there sir" }],
  );
  assert.deepEqual(r, []);
});

test("two near-identical sends each take their own item, nearest first", () => {
  const body = "Payment reminder for your account";
  const r = matchReceipts(
    [
      { id: "a", providerRef: null, sentAt: at("2026-10-06T07:00:00Z"), body },
      { id: "b", providerRef: null, sentAt: at("2026-10-06T07:02:00Z"), body },
    ],
    [
      { id: "1", eventType: "broadcastMessage", statusString: "READ", created: "2026-10-06T07:00:01Z", finalText: body },
      { id: "2", eventType: "broadcastMessage", statusString: "DELIVERED", created: "2026-10-06T07:02:01Z", finalText: body },
    ],
  );
  assert.deepEqual(r, [
    { messageId: "a", status: "read" },
    { messageId: "b", status: "delivered" },
  ]);
});

test("formatting marks and spacing do not stop words matching", () => {
  assert.equal(wordsKey("*Dear*  _Sir_"), wordsKey("Dear Sir"));
});

test("a number becomes Wati's key, and a non-mobile is refused", () => {
  assert.equal(watiWaId("9699342884"), "919699342884");
  assert.equal(watiWaId("+91 92708 23452"), "919270823452");
  assert.equal(watiWaId("02212345678"), null);
});
