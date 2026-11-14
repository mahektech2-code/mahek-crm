import test from "node:test";
import assert from "node:assert/strict";
import {
  BUYING_COMPETITOR,
  CASUAL_TALK_PURPOSES,
  COMPLAINT_ACTIONS,
  deskForAction,
  FOLLOW_UP_REASONS,
  FUTURE_OPPORTUNITY,
  NEVER_CALL_AGAIN,
  NO_ANSWER_REASONS,
  NO_ORDER_REASONS,
  NOT_INTERESTED_REASONS,
  outcomeFieldRequired,
  outcomeFieldsFor,
  outcomeFieldsVisible,
} from "@/lib/call-outcomes";
import { nextActionsFor, reminderTypeFor, wantsDate } from "@/lib/call-reasons";

/* ---------------------------------------------------------------------------
 * WHAT EACH OUTCOME ASKS FOR.
 * ------------------------------------------------------------------------- */

test("every coded list is unique and carries a residual where one is possible", () => {
  /* A duplicate code is two rows that count as one; a missing residual is a
     caller whose answer is not on the list being filed under whichever option
     looks nearest, which is worse than unclassified. */
  for (const [name, list, needsOther] of [
    ["no order", NO_ORDER_REASONS, true],
    ["not interested", NOT_INTERESTED_REASONS, true],
    ["casual talk", CASUAL_TALK_PURPOSES, true],
    ["follow-up", FOLLOW_UP_REASONS, false],
    ["no answer", NO_ANSWER_REASONS, false],
    ["complaint action", COMPLAINT_ACTIONS, false],
  ] as const) {
    const codes = list.map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length, `${name} has a duplicate code`);
    if (needsOther) assert.ok(codes.includes("other"), `${name} has no residual`);
  }
});

test("ten is ten, where the brief said ten", () => {
  assert.equal(NO_ORDER_REASONS.length, 10);
  assert.equal(NOT_INTERESTED_REASONS.length, 10);
});

test("no answer asks one question and nothing else", () => {
  /* Nobody spoke to anybody. A form of any size is one a telecaller working
     down a list of forty fills in at speed and stops reading. */
  const fields = outcomeFieldsFor("no_answer");
  assert.equal(fields.length, 1);
  assert.equal(fields[0].key, "whyNoAnswer");
  assert.equal(fields[0].required, true);
});

test("the competitor is asked only of somebody buying from one", () => {
  const asked = outcomeFieldsVisible("not_interested", {
    whyNotInterested: BUYING_COMPETITOR,
    futureOpportunity: "no",
  }).map((f) => f.key);
  assert.ok(asked.includes("competitorName"));

  const notAsked = outcomeFieldsVisible("not_interested", {
    whyNotInterested: "no_requirement",
    futureOpportunity: "no",
  }).map((f) => f.key);
  assert.ok(
    !notAsked.includes("competitorName"),
    "asking a customer's competitor when they said they have no requirement",
  );
});

test("the competitor's name is asked and never demanded", () => {
  /* A telecaller is often told "somebody cheaper" and no more. Refusing the
     save over it would lose the reason in order to win the name. */
  const [field] = outcomeFieldsVisible("not_interested", {
    whyNotInterested: BUYING_COMPETITOR,
  }).filter((f) => f.key === "competitorName");
  assert.ok(field);
  assert.equal(outcomeFieldRequired(field, { whyNotInterested: BUYING_COMPETITOR }), false);
});

test("a recall date is demanded exactly when there is a later", () => {
  /* "Possible later, no date" is the state that makes a lapsed customer
     invisible for ever — nothing brings them back. */
  const withLater = { futureOpportunity: "possible_later" };
  const visible = outcomeFieldsVisible("not_interested", withLater);
  const recall = visible.find((f) => f.key === "recallDate");
  assert.ok(recall, "no date asked of somebody who said there is a later");
  assert.equal(outcomeFieldRequired(recall, withLater), true);

  assert.ok(
    !outcomeFieldsVisible("not_interested", { futureOpportunity: "no" }).some(
      (f) => f.key === "recallDate",
    ),
    "a date asked of somebody who said there is no later",
  );
});

test("the three futures include the one that silences the customer", () => {
  const codes = FUTURE_OPPORTUNITY.map((f) => f.code);
  assert.deepEqual(codes, ["possible_later", "no", NEVER_CALL_AGAIN]);
  /* Last, and worded as the customer's own request — it writes
     `do_not_contact`, which outranks every reason the queue can produce. */
  assert.match(FUTURE_OPPORTUNITY[2].label, /not to call/i);
});

test("what the customer wants done is what routes it", () => {
  for (const a of COMPLAINT_ACTIONS) {
    assert.ok(a.desk, `${a.code} routes nowhere`);
    assert.equal(deskForAction(a.code), a.desk);
  }
  /* Null rather than "Operations": that default is exactly what this replaces,
     and falling back to it would make every complaint look routed again. */
  assert.equal(deskForAction(null), null);
  assert.equal(deskForAction("not_an_action"), null);
});

/* ---------------------------------------------------------------------------
 * The next actions, which the outcome now owns.
 * ------------------------------------------------------------------------- */

test("the outcome's list wins over the reason's", () => {
  /* Somebody who rang to ask a price and ended up ordering needs chasing for
     payment, not sending a quotation. */
  const codes = nextActionsFor("price_quotation", "order_taken").map((a) => a.code);
  assert.deepEqual(codes, [
    "no_follow_up",
    "follow_up_payment",
    "follow_up_dispatch",
    "follow_up_after_delivery",
  ]);
});

test("an outbound order is asked the same four as an inbound one", () => {
  /* No reason to look up — the goods and the money do not care who dialled. */
  assert.deepEqual(
    nextActionsFor(null, "order_taken").map((a) => a.code),
    nextActionsFor("place_order", "order_taken").map((a) => a.code),
  );
});

test("no order and follow-up each offer a way out and a way on", () => {
  const noOrder = nextActionsFor(null, "no_order").map((a) => a.code);
  assert.ok(noOrder.includes("no_follow_up"), "no way to say nothing is needed");
  assert.ok(noOrder.includes("salesman_visit"));
  assert.ok(nextActionsFor(null, "follow_up").length > 0);
});

test("both payment chases take a day, including the one on the promised date", () => {
  /* It sounds like it needs none and is exactly the one that does: a promise
     date can be pushed off a Sunday, and "follow up BEFORE the promised date"
     has no day at all if it is derived from the promise. */
  assert.equal(wantsDate(["follow_up_on_promise"]), true);
  assert.equal(wantsDate(["follow_up_before_promise"]), true);
  assert.equal(wantsDate(["no_follow_up"]), false);
  assert.equal(reminderTypeFor(["follow_up_on_promise"]), "payment_promise");
  assert.equal(reminderTypeFor(["follow_up_dispatch"]), "order_confirmation");
});

test("one act is one code however two lists phrase it", () => {
  /* "Visit customer" on a No Order and "Arrange a visit" on a Follow-up are one
     thing said two ways. Two codes would split the number somebody wants —
     "how many visits did the phones ask for" answered by adding two columns is
     the sort of figure that is quietly wrong for a year. */
  const visitOnNoOrder = nextActionsFor(null, "no_order").find((a) =>
    /visit/i.test(a.label),
  );
  const visitOnFollowUp = nextActionsFor(null, "follow_up").find((a) =>
    /visit/i.test(a.label),
  );
  assert.equal(visitOnNoOrder?.code, visitOnFollowUp?.code);
});
