import test from "node:test";
import assert from "node:assert/strict";
import {
  CALLER_ROLES,
  CALL_REASONS,
  CALL_REASON_CODES,
  CALL_REASON_LABEL,
  DELIVERY_ISSUES,
  NEXT_ACTION_LABEL,
  nextActionsFor,
  reasonFieldsFor,
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
