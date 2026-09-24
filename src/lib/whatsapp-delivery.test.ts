/**
 * The rules that decide whether a WhatsApp message goes through Wati or is
 * copied and pasted, and how Wati's webhooks are read. Pure — no database.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  advancedStatus,
  deliveryRoute,
  flattenForTemplate,
  parseWatiEvent,
  resolveWatiParams,
  waNumber,
} from "./whatsapp-delivery";

const READY = {
  serviceOn: true,
  hasToken: true,
  destKind: "personal" as const,
  watiTemplateName: "payment_reminder_1",
  edited: false,
};

describe("which way a message leaves", () => {
  test("everything in place: the API", () => {
    assert.deepEqual(deliveryRoute(READY), { via: "api" });
  });

  test("the founder's switch off beats everything else", () => {
    const r = deliveryRoute({ ...READY, serviceOn: false });
    assert.equal(r.via, "manual");
    assert.match((r as { why: string }).why, /Founder Dashboard/);
  });

  test("no key, a group, no linked template or an edit: manual, each with its reason", () => {
    for (const [change, pattern] of [
      [{ hasToken: false }, /key/],
      [{ destKind: "group" as const }, /group/],
      [{ watiTemplateName: null }, /not linked/],
      [{ edited: true }, /edited/],
    ] as const) {
      const r = deliveryRoute({ ...READY, ...change });
      assert.equal(r.via, "manual", JSON.stringify(change));
      assert.match((r as { why: string }).why, pattern);
    }
  });
});

describe("a number WhatsApp can reach", () => {
  test("the spellings people type all become 91 + ten digits", () => {
    for (const raw of ["9820011001", "+91 98200 11001", "09820011001", "919820011001", "0091-9820011001"]) {
      assert.equal(waNumber(raw), "919820011001", raw);
    }
  });

  test("a landline, a short number or nothing is refused rather than guessed", () => {
    for (const raw of ["02226541234", "98200", "", null, "4412345678"]) {
      assert.equal(waNumber(raw), null, String(raw));
    }
  });
});

describe("template variables", () => {
  const fields = ["customer", "outstanding", "bills_list"];

  test("same names fill themselves, and {{name}} is the customer", () => {
    const r = resolveWatiParams(["name", "outstanding"], { customer: "Colour Camp", outstanding: "₹59,086" }, fields);
    assert.deepEqual(r.params, [
      { name: "name", value: "Colour Camp" },
      { name: "outstanding", value: "₹59,086" },
    ]);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.unknown, []);
  });

  test("an empty value is missing and an unmapped name is unknown — neither is sent blank", () => {
    const r = resolveWatiParams(["outstanding", "order_id"], { outstanding: "" }, fields);
    assert.deepEqual(r.params, []);
    assert.deepEqual(r.missing, ["outstanding"]);
    assert.deepEqual(r.unknown, ["order_id"]);
  });

  test("a bill list loses its line breaks, which Meta refuses inside a variable", () => {
    const v = flattenForTemplate("9 Jul 2026 - MMI/25-26/859 - ₹59,086\n\n12 Aug 2026 - MMI/26-27/12 - ₹4,000\n");
    assert.equal(v, "9 Jul 2026 - MMI/25-26/859 - ₹59,086 | 12 Aug 2026 - MMI/26-27/12 - ₹4,000");
    assert.ok(!/\n|\t| {4}/.test(flattenForTemplate("a\tb     c")));
  });
});

describe("reading Wati's webhooks", () => {
  test("status events are matched on our own message id", () => {
    assert.deepEqual(
      parseWatiEvent({ eventType: "sentMessageDELIVERED_v2", localMessageId: "wam_1", whatsappMessageId: "wamid.X" }),
      { kind: "delivered", localMessageId: "wam_1", providerRef: "wamid.X" },
    );
    assert.equal(parseWatiEvent({ eventType: "sentMessageREAD_v2", localMessageId: "wam_1" }).kind, "read");
    assert.equal(parseWatiEvent({ eventType: "templateMessageSent_v2_bsuid", localMessageId: "wam_1" }).kind, "sent");
  });

  test("a failure carries Wati's code and words", () => {
    const e = parseWatiEvent({
      eventType: "templateMessageFailed",
      localMessageId: "wam_1",
      failedCode: "131026",
      failedDetail: "Message undeliverable",
    });
    assert.equal(e.kind, "failed");
    assert.equal((e as { reason: string }).reason, "131026 — Message undeliverable");
  });

  test("a customer's message is a reply; our own echoed back is not", () => {
    const reply = parseWatiEvent({
      eventType: "message",
      waId: "919820011001",
      whatsappMessageId: "wamid.IN",
      text: "Will pay Friday",
      senderName: "Ramesh",
      owner: false,
    });
    assert.deepEqual(reply, {
      kind: "reply",
      providerMessageId: "wamid.IN",
      waId: "919820011001",
      senderName: "Ramesh",
      text: "Will pay Friday",
    });
    assert.equal(parseWatiEvent({ eventType: "message", waId: "91", id: "x", owner: true }).kind, "ignored");
  });

  test("anything else is ignored, never thrown on", () => {
    for (const body of [null, "x", {}, { eventType: "templateStatusUpdate" }, { eventType: "sentMessageREPLIED_v2", localMessageId: "a" }]) {
      assert.equal(parseWatiEvent(body).kind, "ignored", JSON.stringify(body));
    }
  });
});

describe("status only moves forward", () => {
  test("delivered then read, never back", () => {
    assert.equal(advancedStatus("sent", "delivered"), "delivered");
    assert.equal(advancedStatus("delivered", "read"), "read");
    assert.equal(advancedStatus("read", "delivered"), null);
    assert.equal(advancedStatus("read", "sent"), null);
  });

  test("a failure lands on a sent message but not on one already delivered", () => {
    assert.equal(advancedStatus("sent", "failed"), "failed");
    assert.equal(advancedStatus("queued", "failed"), "failed");
    assert.equal(advancedStatus("delivered", "failed"), null);
  });

  test("a manual or cancelled message is never moved by a webhook", () => {
    assert.equal(advancedStatus("sent_manually", "read"), null);
    assert.equal(advancedStatus("cancelled", "delivered"), null);
  });
});
