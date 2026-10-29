import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJourney,
  customerProductName,
  deriveSteps,
  holdRefusal,
  isConfirmed,
  productRows,
  sentenceFor,
  stepForStage,
  trackMessage,
  type LineFacts,
  type TransportFacts,
} from "./order-tracking";

const line = (over: Partial<LineFacts> = {}): LineFacts => ({
  status: "Under Process",
  orderCheck: "Verified",
  orderCheckedAt: "2026-10-28T09:30:00.000Z",
  partyStatus: null,
  createdAt: "2026-10-28T08:00:00.000Z",
  updatedAt: "2026-10-28T09:30:00.000Z",
  billed: false,
  billedAt: null,
  invoiceCheck: null,
  invoiceCheckedAt: null,
  dispatched: false,
  dispatchedAt: null,
  ...over,
});

const road = (over: Partial<TransportFacts> = {}): TransportFacts => ({
  stage: "Dispatched",
  atTransportAt: null,
  lrAttachedAt: null,
  delivered: false,
  deliveredAt: null,
  events: [{ kind: "opened", stage: "Dispatched", at: "2026-10-31T12:40:00.000Z" }],
  ...over,
});

describe("which steps are true", () => {
  test("nothing is shown before the back office verifies, nor while a new customer waits on Accounts", () => {
    assert.equal(deriveSteps({ lines: [line({ orderCheck: "Pending" })], transports: [] }).size, 0);
    assert.equal(deriveSteps({ lines: [line({ partyStatus: "Pending" })], transports: [] }).size, 0);
    assert.equal(isConfirmed([]), false);
  });

  test("verified is confirmed and handed to production, at the verification's own time", () => {
    const s = deriveSteps({ lines: [line(), line()], transports: [] });
    assert.deepEqual([...s.keys()], ["confirmed", "preparing"]);
    assert.equal(s.get("confirmed"), "2026-10-28T09:30:00.000Z");
  });

  test("an order approved by Accounts after verification is confirmed at the approval", () => {
    const s = deriveSteps({ lines: [line({ partyStatus: "Approved By Admin", updatedAt: "2026-10-29T05:00:00.000Z" })], transports: [] });
    assert.equal(s.get("confirmed"), "2026-10-29T05:00:00.000Z");
  });

  test("ready needs every live line ready", () => {
    assert.equal(deriveSteps({ lines: [line({ status: "Ready" }), line()], transports: [] }).has("ready"), false);
    assert.equal(deriveSteps({ lines: [line({ status: "Ready" }), line({ status: "Ready" })], transports: [] }).has("ready"), true);
  });

  test("a billed invoice is shown only once approved — never while rejected", () => {
    const billed = (check: string) => line({ status: "Ready", billed: true, invoiceCheck: check, invoiceCheckedAt: "2026-10-31T07:00:00.000Z" });
    assert.equal(deriveSteps({ lines: [billed("Pending")], transports: [] }).has("invoice"), false);
    assert.equal(deriveSteps({ lines: [billed("Rejected")], transports: [] }).has("invoice"), false);
    assert.equal(deriveSteps({ lines: [billed("Approved")], transports: [] }).get("invoice"), "2026-10-31T07:00:00.000Z");
  });

  test("the road: transporter and transit are implied by anything later; the optional two only when reported", () => {
    const gone = line({ status: "Ready", billed: true, invoiceCheck: "Approved", dispatched: true, dispatchedAt: "2026-10-31T12:40:00.000Z" });
    const delivered = road({
      stage: "Close - Received to Party",
      delivered: true,
      deliveredAt: "2026-11-05T12:00:00.000Z",
      lrAttachedAt: "2026-11-01T06:35:00.000Z",
      events: [
        { kind: "opened", stage: "Dispatched", at: "2026-10-31T12:40:00.000Z" },
        { kind: "lr", stage: "In Transit", at: "2026-11-01T06:35:00.000Z" },
        { kind: "delivered", stage: "Close - Received to Party", at: "2026-11-05T12:00:00.000Z" },
      ],
    });
    const s = deriveSteps({ lines: [gone], transports: [delivered] });
    assert.ok(s.has("at_transport"), "the transporter must have had them");
    assert.equal(s.get("at_transport"), "2026-11-01T06:35:00.000Z", "implied at the next thing that happened, not now");
    assert.equal(s.get("in_transit"), "2026-11-01T06:35:00.000Z");
    assert.equal(s.has("at_destination"), false, "never ticked because a later step was");
    assert.equal(s.has("out_for_delivery"), false);
    assert.equal(s.get("delivered"), "2026-11-05T12:00:00.000Z");
    assert.equal(s.get("lr"), "2026-11-01T06:35:00.000Z");
  });

  test("delivered needs every consignment closed", () => {
    const gone = line({ status: "Ready", billed: true, invoiceCheck: "Approved", dispatched: true, dispatchedAt: "2026-10-31T12:40:00.000Z" });
    const s = deriveSteps({ lines: [gone], transports: [road({ stage: "Close - Received to Party", delivered: true, deliveredAt: "2026-11-05T12:00:00.000Z" }), road()] });
    assert.equal(s.has("delivered"), false);
  });

  test("the logistics words become the customer's steps", () => {
    assert.equal(stepForStage("On the way to Destination area"), "in_transit");
    assert.equal(stepForStage("Out for Delivery"), "out_for_delivery");
    assert.equal(stepForStage("Reached Destination Area"), "at_destination");
    assert.equal(stepForStage("Dispatched"), null);
  });
});

describe("the journey the page draws", () => {
  test("current is the furthest step; the transport steps fold until dispatch", () => {
    const v = buildJourney(
      [
        { step: "confirmed", at: "2026-10-28T09:30:00.000Z" },
        { step: "preparing", at: "2026-10-28T09:30:00.000Z" },
      ],
      [],
    );
    assert.equal(v.current, "preparing");
    assert.equal(v.currentLabel, "Preparing Your Order");
    assert.equal(v.folded, true);
    const pending = v.entries.filter((e) => e.type === "step" && e.state === "pending").map((e) => (e.type === "step" ? e.step : ""));
    assert.deepEqual(pending, ["ready", "invoice", "dispatched"]);
  });

  test("a hold and its resolution sit in the history by time; an open hold is the notice", () => {
    const hold = { kind: "hold" as const, reason: "material_shortage", customerText: "Waiting for materials.", raisedAt: "2026-10-29T05:10:00.000Z", nextUpdateOn: "2026-10-31", revisedDeliveryOn: null, resolvedAt: null, resolutionText: null };
    const open = buildJourney([{ step: "confirmed", at: "2026-10-28T09:30:00.000Z" }, { step: "preparing", at: "2026-10-28T09:30:00.000Z" }], [hold], (c) => (c === "material_shortage" ? "Material shortage" : c));
    assert.equal(open.openHold?.reason, "material_shortage");
    assert.ok(open.entries.some((e) => e.type === "hold" && e.label === "Order On Hold · Material shortage"));
    const closed = buildJourney([{ step: "confirmed", at: "2026-10-28T09:30:00.000Z" }], [{ ...hold, resolvedAt: "2026-10-30T03:45:00.000Z", resolutionText: "Materials received." }]);
    assert.equal(closed.openHold, null);
    const kinds = closed.entries.filter((e) => e.type !== "step").map((e) => e.type);
    assert.deepEqual(kinds, ["hold", "resolved"]);
    assert.equal(closed.lastUpdated, "2026-10-30T03:45:00.000Z");
  });

  test("delivered: nothing pending, and unreported optional steps are said in a line", () => {
    const v = buildJourney(
      ["confirmed", "preparing", "ready", "invoice", "dispatched", "at_transport", "in_transit", "delivered"].map((s, i) => ({ step: s as never, at: `2026-11-0${i + 1}T06:00:00.000Z` })),
      [],
    );
    assert.equal(v.current, "delivered");
    assert.deepEqual(v.unreported, ["at_destination", "out_for_delivery"]);
    assert.ok(v.entries.every((e) => e.type !== "step" || e.state === "done"));
  });

  test("nothing recorded (verification undone) is said, not drawn as a step", () => {
    const v = buildJourney([], []);
    assert.equal(v.current, null);
    assert.equal(v.currentLabel, "Order received — being checked");
  });
});

describe("holds", () => {
  test("a reason from the right list, and a sentence the customer can read", () => {
    assert.equal(holdRefusal({ kind: "hold", reason: "transporter_delay", customerText: "x".repeat(20) }, "2026-10-29")?.field, "reason");
    assert.equal(holdRefusal({ kind: "hold", reason: "other", customerText: "short" }, "2026-10-29")?.message, "Write the reason the customer will read");
    assert.equal(holdRefusal({ kind: "hold", reason: "payment_pending", customerText: "Waiting for your payment.", nextUpdateOn: "2026-10-01" }, "2026-10-29")?.field, "nextUpdateOn");
    assert.equal(holdRefusal({ kind: "delay", reason: "route_delay", customerText: "Road closed near Nagpur." }, "2026-10-29"), null);
  });

  test("admins may reword a reason's sentence; an unset one keeps the shipped words", () => {
    assert.match(sentenceFor("payment_pending", {}), /payment confirmation is pending/);
    assert.equal(sentenceFor("payment_pending", { payment_pending: "On hold until we receive payment." }), "On hold until we receive payment.");
    assert.equal(sentenceFor("other", {}), "");
  });
});

describe("products and the message", () => {
  test("one row per line, never added across units, in cans or drums with the size beside", () => {
    const rows = productRows([
      { name: "Nano Thinner - 5 Liter (6 Can/Box)", goodName: "Nano Thinner - 5 Liter", qtyCans: 12, litresPerCan: 5, cansPerBox: 6, boxed: true, drum: false },
      { name: "PU Thinner - 210 Liter (Drum)", goodName: null, qtyCans: 1, litresPerCan: 210, cansPerBox: 1, boxed: false, drum: true },
    ]);
    assert.deepEqual(rows[0], { name: "Nano Thinner", qty: 12, unit: "Cans", pack: "5 L can · 2 boxes", measure: "60 Litre" });
    assert.deepEqual(rows[1], { name: "PU Thinner", qty: 1, unit: "Drum", pack: "210 L drum", measure: "210 Litre" });
    assert.equal(customerProductName("Hardener"), "Hardener");
  });

  test("the confirmation names the order, its date, each product and the link", () => {
    const body = trackMessage("confirmed", {
      party: "Shree Paints",
      orderNo: 1863,
      orderDate: "2026-10-28",
      products: [{ name: "PU Thinner", qty: 4, unit: "Cans", pack: "5 L can", measure: "20 Litre" }],
      trackUrl: "https://one.mahekindia.com/t/abc",
      signature: "Mahek Marketing India",
    });
    assert.match(body, /Your order has been confirmed by Mahek Marketing India\./);
    assert.match(body, /Order Number: 1863/);
    assert.match(body, /Order Date: 28 Oct 2026/);
    assert.match(body, /• PU Thinner \(5 L can\) — 4 Cans/);
    assert.match(body, /Track your order: https:\/\/one\.mahekindia\.com\/t\/abc/);
  });
});
