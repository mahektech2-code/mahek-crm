import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CAPTION_MAX, checkCaption, checkText, mergeStatus, normalizeMessage, parseWebhook, phoneKey, previewOf, sendableNumber, statusOf, windowState, listText, mediaWords } from "./inbox";
import { signBody, verifySignature } from "./inbox-signature";

describe("inbox — a status only moves forward", () => {
  test("a late delivered never demotes read", () => {
    assert.equal(mergeStatus("read", "delivered"), "read");
    assert.equal(mergeStatus("sent", "delivered"), "delivered");
    assert.equal(mergeStatus("delivered", "read"), "read");
    assert.equal(mergeStatus(null, "sent"), "sent");
    assert.equal(mergeStatus("sent", null), "sent");
    assert.equal(mergeStatus(null, null), "pending");
  });
  test("a failure replaces a message nobody received, but never un-delivers one", () => {
    assert.equal(mergeStatus("pending", "failed"), "failed");
    assert.equal(mergeStatus("sent", "failed"), "failed");
    assert.equal(mergeStatus("delivered", "failed"), "delivered");
    assert.equal(mergeStatus("read", "failed"), "read");
    assert.equal(mergeStatus("failed", "sent"), "failed");
    assert.equal(mergeStatus("failed", "delivered"), "delivered");
  });
  test("an unknown word is no status", () => {
    assert.equal(statusOf("received"), null);
    assert.equal(statusOf("DELIVERED"), "delivered");
    assert.equal(statusOf(undefined), null);
  });
});

describe("inbox — two spellings of one mobile are one key", () => {
  test("last ten digits", () => {
    for (const s of ["9820011111", "09820011111", "+91 98200-11111", "919820011111"]) assert.equal(phoneKey(s), "9820011111");
    assert.equal(phoneKey("12345"), null);
    assert.equal(phoneKey(null), null);
  });
  test("a sendable number carries its country code", () => {
    assert.equal(sendableNumber("9820011111"), "919820011111");
    assert.equal(sendableNumber("+91 98200 11111"), "919820011111");
    assert.equal(sendableNumber("123"), null);
  });
});

describe("inbox — the 24-hour window", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  test("open for 24 hours after the customer's last message", () => {
    assert.equal(windowState(new Date("2026-11-19T11:00:00Z"), now).open, true);
    assert.equal(windowState(new Date("2026-11-19T09:59:00Z"), now).open, false);
  });
  test("a conversation the customer never wrote in has no window", () => {
    assert.deepEqual(windowState(null, now), { open: false, closesAt: null });
  });
});

describe("inbox — what may be sent", () => {
  test("text and caption limits", () => {
    assert.ok(checkText("   "));
    assert.equal(checkText("Hello"), null);
    assert.ok(checkText("x".repeat(5000)));
    assert.equal(checkCaption("x".repeat(CAPTION_MAX)), null);
    assert.ok(checkCaption("x".repeat(CAPTION_MAX + 1)));
  });
});

const inbound = {
  phone_number_id: "PN1",
  is_new_conversation: true,
  message: { id: "wamid.IN1", timestamp: "1795000000", type: "text", from: "919820011111", text: { body: "Hi, poster?" }, kapso: { direction: "inbound", status: "received", origin: "cloud_api", has_media: false, content: "Hi, poster?" } },
  conversation: { id: "conv-1", phone_number: "919820011111", phone_number_id: "PN1", kapso: { contact_name: "Shree Paints", last_inbound_at: "2026-11-20T08:00:00Z" } },
};

describe("inbox — Kapso's note on a file is not a message", () => {
  const note = "Image attached (image_a8.jpeg) [Size: 173.3 KB | Type: image/jpeg] URL: https://app.kapso.ai/rails/active_storage/blobs/x/image_a8.jpeg";
  test("the note is dropped and the person's own caption stays", () => {
    assert.deepEqual(mediaWords(true, note, null), { body: null, caption: null });
    assert.deepEqual(mediaWords(true, note, "Happy Diwali"), { body: null, caption: "Happy Diwali" });
    assert.deepEqual(mediaWords(true, "Happy Diwali [Image attached]", "Happy Diwali"), { body: null, caption: "Happy Diwali" });
    assert.deepEqual(mediaWords(true, "Happy Diwali [Image attached]", null), { body: null, caption: "Happy Diwali" });
    const m = normalizeMessage({ id: "wamid.IMG", type: "image", image: {}, kapso: { direction: "outbound", has_media: true, content: note } });
    assert.equal(m?.body, null);
    assert.equal(previewOf(m!), "📷 Photo");
  });
  test("a typed message is never touched, and the list line reads as words", () => {
    assert.deepEqual(mediaWords(false, note, null), { body: note, caption: null });
    assert.equal(listText(note.slice(0, 140)), "📷 Photo");
    assert.equal(listText("Happy Diwali [Image attached]"), "Happy Diwali");
    assert.equal(listText("Hi"), "Hi");
  });
});

describe("inbox — a Kapso v2 webhook body", () => {
  test("received: an inbound message and its conversation", () => {
    const e = parseWebhook("whatsapp.message.received", inbound);
    assert.equal(e.phoneNumberId, "PN1");
    assert.equal(e.conversation?.id, "conv-1");
    assert.equal(e.conversation?.contactName, "Shree Paints");
    assert.equal(e.message?.wamid, "wamid.IN1");
    assert.equal(e.message?.direction, "inbound");
    assert.equal(e.message?.status, null);
    assert.equal(e.message?.body, "Hi, poster?");
    assert.equal(e.message?.at.getTime(), 1795000000 * 1000);
  });
  test("delivered: the event name asserts the status even where the body is silent", () => {
    const body = { phone_number_id: "PN1", message: { id: "wamid.OUT1", timestamp: "1795000100", type: "text", to: "919820011111", text: { body: "Sure" }, kapso: { direction: "outbound" } } };
    assert.equal(parseWebhook("whatsapp.message.delivered", body).message?.status, "delivered");
  });
  test("failed: carries the reason Meta gave", () => {
    const body = {
      message: { id: "wamid.OUT2", timestamp: "1795000200", type: "text", text: { body: "x" }, kapso: { direction: "outbound", status: "failed", statuses: [{ status: "failed", errors: [{ code: 131047, title: "Re-engagement message", message: "More than 24 hours have passed" }] }] } },
    };
    const m = parseWebhook("whatsapp.message.failed", body).message;
    assert.equal(m?.status, "failed");
    assert.equal(m?.errorCode, "131047");
    assert.match(m?.errorText ?? "", /24 hours/);
  });
  test("an image keeps its caption and its media reference", () => {
    const m = normalizeMessage({ id: "wamid.IMG", timestamp: 1795000300, type: "image", image: { caption: "Diwali" }, kapso: { direction: "inbound", has_media: true, media_data: { url: "https://x/y.jpg", content_type: "image/jpeg" } } });
    assert.equal(m?.hasMedia, true);
    assert.equal(m?.caption, "Diwali");
    assert.equal(m?.mediaUrl, "https://x/y.jpg");
    assert.equal(previewOf(m!), "Diwali");
  });
  test("a body with no message contributes nothing, and a message with no id is not one", () => {
    const e = parseWebhook("whatsapp.message.received", { phone_number_id: "PN1" });
    assert.equal(e.message, null);
    assert.equal(normalizeMessage({ type: "text" }), null);
    assert.equal(normalizeMessage("nonsense"), null);
  });
});

describe("inbox — webhook signature", () => {
  const body = JSON.stringify(inbound);
  test("a correct signature verifies; any change does not", () => {
    const sig = signBody(body, "s3cret");
    assert.equal(verifySignature(body, sig, "s3cret"), true);
    assert.equal(verifySignature(body + " ", sig, "s3cret"), false);
    assert.equal(verifySignature(body, sig, "other"), false);
    assert.equal(verifySignature(body, sig.replace(/.$/, "0"), "s3cret"), sig.endsWith("0"));
  });
  test("no secret, no header or a malformed one verifies nothing", () => {
    assert.equal(verifySignature(body, signBody(body, "s"), ""), false);
    assert.equal(verifySignature(body, signBody(body, "s"), null), false);
    assert.equal(verifySignature(body, null, "s"), false);
    assert.equal(verifySignature(body, "nothex", "s"), false);
  });
});
