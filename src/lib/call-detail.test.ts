import test from "node:test";
import assert from "node:assert/strict";
import { describeCall } from "@/lib/call-detail";
import {
  nextActionsFor,
  reasonFieldsFor,
  reminderTypeFor,
  visibleReasonFields,
  wantsDate,
} from "@/lib/call-reasons";

/* ---------------------------------------------------------------------------
 * WHAT A CALL RECORDED, as lines.
 *
 * The columns were written for a long time before any screen drew them. These
 * pin the two things that matter about drawing them: that every call logged
 * before them draws exactly as it did (nothing), and that "asked and the answer
 * was no" is not the same sentence as silence.
 * ------------------------------------------------------------------------- */

test("a call with nothing recorded beyond a note draws nothing at all", () => {
  assert.equal(describeCall({ interactionType: "outbound_call", outcome: "no_order" }), null);
  assert.equal(
    describeCall({
      callReason: null,
      callerRole: null,
      reasonDetail: null,
      outcomeDetail: null,
      nextActions: [],
      opportunityAnswer: null,
      opportunity: null,
      contextSnapshot: null,
    }),
    null,
    "every historical row has exactly this shape",
  );
});

test("an inbound call says why, who, the answers, the next action and the opportunity", () => {
  const v = describeCall({
    interactionType: "inbound_call",
    outcome: "follow_up",
    callReason: "price_quotation",
    callerRole: "purchase",
    callerName: "Ramesh",
    reasonDetail: { product: "PU Clear 20L", quotationRequired: "yes" },
    outcomeDetail: { followUpReason: "waiting_quotation" },
    nextActions: ["send_quotation", "follow_up_date"],
    nextActionDate: "2026-10-20",
    opportunityAnswer: "yes",
    opportunity: {
      product: "PU Clear 20L",
      estimatedQuantity: "20 cans a month",
      estimatedValuePaise: 4_000_000,
      expectedOrderDate: "2026-11-01",
      status: "open",
    },
  });
  assert.ok(v);
  assert.equal(v.summary, "Price / Quotation · Purchase Person (Ramesh)");
  const byLabel = Object.fromEntries(v.lines.map((l) => [l.label, l.value]));
  assert.equal(byLabel["Why they called"], "Price / Quotation");
  assert.equal(byLabel["Who called"], "Purchase Person (Ramesh)");
  assert.equal(byLabel["Product"], "PU Clear 20L");
  assert.equal(byLabel["Quotation required?"], "Yes");
  assert.equal(byLabel["What are we waiting for"], "Waiting for quotation");
  assert.match(byLabel["Next action"], /Send quotation, Follow-up date — by /);
  assert.match(byLabel["Opportunity"], /PU Clear 20L · 20 cans a month · .*40,000/);
});

test("Opportunity = No is SAID, and unanswered is not", () => {
  const no = describeCall({ callReason: "other", opportunityAnswer: "no" });
  assert.ok(no?.lines.some((l) => l.label === "Opportunity" && /None/.test(l.value)));
  const silent = describeCall({ callReason: "other", opportunityAnswer: null });
  assert.ok(silent && !silent.lines.some((l) => l.label === "Opportunity"));
});

test("system fields are not drawn as answers; the snapshot is drawn instead", () => {
  const v = describeCall({
    callReason: "delivery_transport",
    reasonDetail: { orderRef: "Order 5 / bill B-9", issue: "delayed", erpOrderNo: "5" },
    contextSnapshot: {
      delivery: {
        orderNo: 5,
        billNo: "B-9",
        transporter: "VRL",
        lrNo: "LR123",
        plannedDispatch: "2026-10-01",
        dispatchedOn: null,
        stage: "Dispatched",
        status: "Ready",
      },
    },
  });
  assert.ok(v);
  assert.ok(!v.lines.some((l) => l.label === "ERP order" && l.value === "5"));
  const erp = v.lines.find((l) => l.label === "ERP order at the time");
  assert.match(erp?.value ?? "", /Order 5 · bill B-9 · via VRL · LR LR123 · planned for/);
  assert.equal(v.lines.find((l) => l.label === "Issue")?.value, "Delayed");
});

test("a payment snapshot says what was owed on the day", () => {
  const v = describeCall({
    callReason: "payment_outstanding",
    reasonDetail: { customerQuery: "Which bills?", paymentPosition: "disputed" },
    contextSnapshot: {
      payment: { outstandingPaise: 12_500_00, billCount: 2, bills: [] },
    },
  });
  assert.equal(v?.lines.find((l) => l.label === "Payment status")?.value, "Disputes the amount");
  assert.match(v?.lines.find((l) => l.label === "Owed at the time")?.value ?? "", /12,500.*2 open bills/);
});

test("a failed stock read is said, not hidden", () => {
  const v = describeCall({
    callReason: "stock_availability",
    contextSnapshot: { stock: { unavailable: true } },
  });
  assert.match(v?.lines.find((l) => l.label === "Stock shown at the time")?.value ?? "", /could not be read/);
});

test("handed-over actions are shown with who has them", () => {
  const v = describeCall({
    callReason: "price_quotation",
    nextActions: ["salesman_visit"],
    nextActionDate: "2026-10-20",
    contextSnapshot: {
      routing: [{ action: "salesman_visit", to: "Mahesh", note: "the salesperson on the account, by 20 Oct" }],
    },
  });
  assert.match(v?.lines.find((l) => l.label === "Handed to")?.value ?? "", /Mahesh/);
});

test("an unknown code or a key the list no longer asks still prints", () => {
  const v = describeCall({
    callReason: "price_quotation",
    reasonDetail: { oldQuestion: "an answer somebody gave" },
    nextActions: ["some_retired_action"],
    nextActionDate: "2026-10-20",
  });
  assert.ok(v?.lines.some((l) => l.label === "oldQuestion"));
  assert.match(v?.lines.find((l) => l.label === "Next action")?.value ?? "", /some_retired_action/);
});

/* ------------------------------------------------- the vocabulary additions */

test("Follow-up date is a dated action on Price / Quotation, and becomes a call-back reminder", () => {
  assert.ok(nextActionsFor("price_quotation").some((a) => a.code === "follow_up_date"));
  assert.equal(wantsDate(["follow_up_date"]), true);
  assert.equal(reminderTypeFor(["follow_up_date"]), "call_back");
});

test("system fields exist on delivery and stock but are never drawn as boxes", () => {
  const delivery = reasonFieldsFor("delivery_transport");
  assert.ok(delivery.some((f) => f.key === "erpOrderNo" && f.system));
  assert.ok(!visibleReasonFields(delivery).some((f) => f.key === "erpOrderNo"));
  assert.ok(visibleReasonFields(delivery).some((f) => f.key === "orderRef"), "the typed box is untouched");

  const stock = reasonFieldsFor("stock_availability");
  assert.ok(stock.some((f) => f.key === "skuId" && f.system));
  assert.ok(visibleReasonFields(stock).some((f) => f.key === "product" && f.required), "product is still required");
});

test("Payment status is a coded box BESIDE the free text, which stays", () => {
  const f = reasonFieldsFor("payment_outstanding");
  assert.ok(f.some((x) => x.key === "paymentStatus" && x.kind === "text"));
  const coded = f.find((x) => x.key === "paymentPosition");
  assert.equal(coded?.kind, "choice");
  assert.equal(coded?.required, undefined, "optional — history has none");
});
