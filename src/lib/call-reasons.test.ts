import test from "node:test";
import assert from "node:assert/strict";
import {
  CALLER_ROLES,
  CALL_REASONS,
  CALL_REASON_CODES,
  CALL_REASON_LABEL,
  DELIVERY_ISSUES,
  ALL_NEXT_ACTION_CODES,
  NEXT_ACTION_LABEL,
  nextActionCoveredByOutcome,
  nextActionsFor,
  reasonFieldsFor,
  reconcileNextActions,
  reminderTypeFor,
  showsLedger,
  unbackedBy,
  wantsDate,
} from "@/lib/call-reasons";

/* ---------------------------------------------------------------------------
 * WHY THE CUSTOMER RANG.
 *
 * Everything here is read by two runtimes that cannot import each other's
 * checks — the form in a browser and `saveInteraction` under `server-only` —
 * so what is pinned is the shape both of them rely on. A reason whose fields
 * the form can draw and the server cannot validate is the failure mode, and it
 * is invisible until somebody is refused a save they cannot fix.
 * ------------------------------------------------------------------------- */

test("every reason has a label, and the codes list matches the reasons", () => {
  for (const r of CALL_REASONS) {
    assert.equal(CALL_REASON_LABEL[r.code], r.label);
  }
  assert.deepEqual(
    CALL_REASON_CODES,
    CALL_REASONS.map((r) => r.code),
  );
});

test("there are ten reasons and a residual among them", () => {
  /* Ten is what the business asked for, and the residual is what keeps a caller
     whose reason is not on the list from being filed under whichever option
     looks nearest — which is worse than unclassified. */
  assert.equal(CALL_REASONS.length, 10);
  assert.ok(CALL_REASON_CODES.includes("other"));
});

test("every reason offers at least one next action", () => {
  /* A reason with no actions draws an empty block on the screen, which reads as
     a section that failed to load rather than one with nothing to offer. */
  for (const r of CALL_REASONS) {
    assert.ok(
      nextActionsFor(r.code).length > 0,
      `${r.code} offers no next action`,
    );
  }
});

test("every next action code anywhere has a label", () => {
  /* A history screen reads a code stored months ago against a list that may
     since have been re-cut, so it cannot go through `nextActionsFor`. A missing
     entry is a raw enum name in front of somebody, mid-call.
     
     It asserts the code is KNOWN rather than that the label matches this
     particular list's phrasing: one act is one code however two lists word it,
     and the map deliberately keeps one canonical phrasing for the screen that
     renders it months later. */
  const outcomes = [
    "order_taken",
    "no_order",
    "follow_up",
    "payment_promised",
    "not_interested",
    "casual_talk",
  ];
  const codes = [
    ...CALL_REASONS.flatMap((r) => nextActionsFor(r.code).map((a) => a.code)),
    ...outcomes.flatMap((o) => nextActionsFor(null, o).map((a) => a.code)),
  ];
  for (const code of codes) {
    assert.ok(NEXT_ACTION_LABEL[code], `${code} has no label`);
  }
});

test("an unknown reason asks nothing and offers nothing", () => {
  /* Null is the fourth answer — every call logged before the column existed
     carries one — and it must fall through rather than throw. */
  assert.deepEqual(nextActionsFor(null), []);
  assert.deepEqual(nextActionsFor(undefined), []);
  assert.deepEqual(reasonFieldsFor("not_a_reason"), []);
  assert.equal(wantsDate([]), false);
});

test("a choice field always carries its options", () => {
  /* The server validates a choice against `f.options`. One without them would
     accept any string at all, which is the whole of "a reason is a code, never
     a label" failing quietly. */
  for (const r of CALL_REASONS) {
    for (const f of reasonFieldsFor(r.code)) {
      if (f.kind === "choice") {
        assert.ok(f.options?.length, `${r.code}.${f.key} is a choice with no options`);
      }
    }
  }
});

test("the reasons that ask something ask for the thing that identifies it", () => {
  /* A price enquiry with no product named is a note saying somebody rang about
     a price, which is what the section exists to stop. */
  for (const reason of [
    "price_quotation",
    "product_enquiry",
    "stock_availability",
    "technical_support",
  ]) {
    const fields = reasonFieldsFor(reason);
    const product = fields.find((f) => f.key === "product");
    assert.ok(product?.required, `${reason} does not insist on a product`);
  }
  /* Delivery is the exception and deliberately so: the customer quotes an order
     number we may not hold, and the ISSUE is the part that has to be a code. */
  const delivery = reasonFieldsFor("delivery_transport");
  assert.equal(delivery.find((f) => f.key === "orderRef")?.required, undefined);
  assert.equal(delivery.find((f) => f.key === "issue")?.required, true);
});

test("a date is demanded where an action means one, and not otherwise", () => {
  assert.equal(wantsDate(["send_quotation"]), true);
  assert.equal(wantsDate(["salesman_visit"]), true);
  /* A statement about the past. A date box beside it is a question nobody can
     answer, and the server refuses one rather than storing a meaningless day. */
  assert.equal(wantsDate(["payment_already_made"]), false);
  assert.equal(wantsDate(["inform_customer"]), false);
  /* One dated action among several is enough — the errand still has to land on
     somebody's day. */
  assert.equal(wantsDate(["payment_already_made", "accounts_follow_up"]), true);
});

test("a dated action becomes the right kind of reminder", () => {
  /* `send_information` and `check_stock` have been in `reminderTypeEnum` since
     the CRM shipped with nothing ever writing one. These are what they were
     for, and getting the mapping wrong files an errand under a call-back. */
  assert.equal(reminderTypeFor(["send_quotation"]), "send_information");
  assert.equal(reminderTypeFor(["send_brochure"]), "send_information");
  assert.equal(reminderTypeFor(["arrange_stock"]), "check_stock");
  assert.equal(reminderTypeFor(["call_back"]), "call_back");
  assert.equal(reminderTypeFor(["escalate"]), "other");
  /* Stock wins over information when both were promised: the thing that has to
     be found out is what the day is actually for. */
  assert.equal(reminderTypeFor(["send_price", "check_stock"]), "check_stock");
});

test("only the payment conversation reads the ledger back", () => {
  /* Drawing the outstanding figure on every call would make it furniture — the
     mistake the microphone made when it was drawn at the weight of the resize
     grip. */
  assert.equal(showsLedger("payment_outstanding"), true);
  assert.equal(showsLedger("price_quotation"), false);
  assert.equal(showsLedger(null), false);
});

test("the two reasons with no record behind them say so", () => {
  /* There is no quotation record and no stock system. A screen that implied
     otherwise would have somebody telling a customer stock is confirmed on the
     strength of a dropdown. */
  assert.ok(unbackedBy("price_quotation"));
  assert.ok(unbackedBy("stock_availability"));
  assert.equal(unbackedBy("payment_outstanding"), null);
  assert.equal(unbackedBy(null), null);
});

test("who rang is a closed list with a residual", () => {
  const codes = CALLER_ROLES.map((r) => r.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.includes("other"));
});

test("delivery issues are codes, and unique", () => {
  const codes = DELIVERY_ISSUES.map((i) => i.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.includes("other"));
});

/* ----------------------------------------------- the model's closed list */

test("the model may name every code the form can draw, and no other", () => {
  assert.deepEqual(
    [...ALL_NEXT_ACTION_CODES].sort(),
    Object.keys(NEXT_ACTION_LABEL).sort(),
  );
  for (const r of CALL_REASONS) {
    for (const a of nextActionsFor(r.code)) {
      assert.ok(ALL_NEXT_ACTION_CODES.includes(a.code), a.code);
    }
  }
});

/* ------------------------------------------- stale state, and the proposal
 *
 * `reconcileNextActions` is what the panel runs when an outcome changes and
 * when the assistant proposes — pure, so the rule is pinned without a browser.
 * ------------------------------------------------------------------------- */

const TODAY = "2026-09-24";
const base = {
  current: [] as string[],
  currentDate: "",
  reason: null as string | null,
  outcome: null as string | null,
  today: TODAY,
};

test("changing the outcome drops what the new outcome no longer offers, and its day", () => {
  /* Order taken chased for payment, then the outcome becomes No Order. */
  const r = reconcileNextActions({
    ...base,
    current: ["follow_up_payment"],
    currentDate: "2026-09-30",
    outcome: "no_order",
  });
  assert.deepEqual(r.actions, []);
  assert.equal(r.date, "", "a day with nothing dated left goes with it");
  assert.equal(r.dropped, true);
});

test("changing the outcome keeps what is still offered, and its day", () => {
  /* "Call again" is on both No Order and Follow-up. */
  const r = reconcileNextActions({
    ...base,
    current: ["call_back", "follow_up_payment"],
    currentDate: "2026-09-30",
    outcome: "follow_up",
  });
  assert.deepEqual(r.actions, ["call_back"]);
  assert.equal(r.date, "2026-09-30");
  assert.equal(r.dropped, true);
});

test("changing the reason drops codes the new reason does not list", () => {
  /* Inbound: a price enquiry's "send price", then the reason is a complaint. */
  const r = reconcileNextActions({
    ...base,
    current: ["send_price"],
    currentDate: "2026-09-30",
    reason: "complaint",
    outcome: null,
  });
  assert.deepEqual(r.actions, []);
  assert.equal(r.date, "");
});

test("nothing stale is reported when nothing is stale", () => {
  const r = reconcileNextActions({
    ...base,
    current: ["call_back"],
    currentDate: "2026-09-30",
    outcome: "follow_up",
  });
  assert.equal(r.dropped, false);
  assert.equal(r.filled, false);
  assert.deepEqual(r.actions, ["call_back"]);
});

test("a proposal is checked against the INCOMING outcome and reason", () => {
  /* Valid for the outcome the assistant is about to set… */
  const ok = reconcileNextActions({
    ...base,
    outcome: "follow_up",
    proposed: ["call_back"],
    proposedDate: "2026-09-25",
  });
  assert.deepEqual(ok.actions, ["call_back"]);
  assert.equal(ok.date, "2026-09-25");
  assert.equal(ok.filled, true);
  /* …and refused for one whose list does not have it. */
  const no = reconcileNextActions({
    ...base,
    outcome: "no_answer",
    proposed: ["call_back"],
    proposedDate: "2026-09-25",
  });
  assert.deepEqual(no.actions, []);
  assert.equal(no.filled, false);
  /* Inbound reason lists apply only when a reason is given. */
  const inbound = reconcileNextActions({
    ...base,
    reason: "price_quotation",
    outcome: "no_answer",
    proposed: ["send_price"],
    proposedDate: "2026-09-25",
  });
  assert.deepEqual(inbound.actions, ["send_price"]);
});

test("a proposal never replaces what the telecaller already chose", () => {
  const r = reconcileNextActions({
    ...base,
    current: ["salesman_visit"],
    currentDate: "2026-09-29",
    outcome: "follow_up",
    proposed: ["call_back"],
    proposedDate: "2026-09-25",
  });
  assert.deepEqual(r.actions, ["salesman_visit"]);
  assert.equal(r.date, "2026-09-29");
  assert.equal(r.filled, false);
});

test("no_follow_up is exclusive: beside another action the proposal is refused whole", () => {
  const r = reconcileNextActions({
    ...base,
    outcome: "no_order",
    proposed: ["no_follow_up", "call_back"],
  });
  assert.deepEqual(r.actions, []);
  assert.equal(r.filled, false);
  const alone = reconcileNextActions({
    ...base,
    outcome: "no_order",
    proposed: ["no_follow_up"],
    proposedDate: "2026-09-25",
  });
  assert.deepEqual(alone.actions, ["no_follow_up"]);
  assert.equal(alone.date, "", "an undated action takes no day");
});

test("a proposed day that is past, or for an undated action, is not set", () => {
  const past = reconcileNextActions({
    ...base,
    outcome: "follow_up",
    proposed: ["call_back"],
    proposedDate: "2026-09-01",
  });
  assert.deepEqual(past.actions, ["call_back"]);
  assert.equal(past.date, "");
  const undated = reconcileNextActions({
    ...base,
    reason: "payment_outstanding",
    outcome: null,
    proposed: ["payment_already_made"],
    proposedDate: "2026-09-25",
  });
  assert.deepEqual(undated.actions, ["payment_already_made"]);
  assert.equal(undated.date, "");
});

/* --------------------------------------------- one promise, one reminder */

test("a Next Action the outcome already wrote a reminder for is covered", () => {
  const follow = [{ type: "call_back", day: "2026-09-25" }];
  assert.equal(nextActionCoveredByOutcome(["call_back"], "2026-09-25", follow), true);
  /* The payment chase on the promised day is the promise's own reminder. */
  assert.equal(
    nextActionCoveredByOutcome(
      ["follow_up_on_promise"],
      "2026-09-25",
      [{ type: "payment_promise", day: "2026-09-25" }],
    ),
    true,
  );
});

test("a different day, a different errand or a different type is NOT covered", () => {
  const follow = [{ type: "call_back", day: "2026-09-25" }];
  /* Two promises on two days both stand. */
  assert.equal(nextActionCoveredByOutcome(["call_back"], "2026-09-29", follow), false);
  /* "Send the price" is an errand a call-back reminder does not mean — and a
     set holding it is never covered, even beside a covered call-back. */
  assert.equal(nextActionCoveredByOutcome(["send_price"], "2026-09-25", follow), false);
  assert.equal(
    nextActionCoveredByOutcome(["call_back", "salesman_visit"], "2026-09-25", follow),
    false,
  );
  /* A promise reminder does not cover a plain call-back, nor the reverse. */
  assert.equal(
    nextActionCoveredByOutcome(
      ["call_back"],
      "2026-09-25",
      [{ type: "payment_promise", day: "2026-09-25" }],
    ),
    false,
  );
  /* "Before the promised date" is earlier by definition, so a different day. */
  assert.equal(
    nextActionCoveredByOutcome(
      ["follow_up_before_promise"],
      "2026-09-25",
      [{ type: "payment_promise", day: "2026-09-25" }],
    ),
    false,
  );
});

test("with no outcome reminder, or no action, nothing is covered", () => {
  assert.equal(nextActionCoveredByOutcome(["call_back"], "2026-09-25", []), false);
  assert.equal(
    nextActionCoveredByOutcome([], "2026-09-25", [{ type: "call_back", day: "2026-09-25" }]),
    false,
  );
});
