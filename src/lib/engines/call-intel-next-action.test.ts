import test from "node:test";
import assert from "node:assert/strict";
import { decideCallActions, type DecideInput } from "./call-intel-decide";
import { readNothingFurther } from "./call-intel-signals";
import type { CallReading } from "@/lib/call-intel-schema";

/* ---------------------------------------------------------------------------
 * WHAT THE TELECALLER SAID THEY WILL DO NEXT.
 *
 * The model names an act; the decide layer decides whether THIS call may carry
 * it. 24 Sep 2026 is a Thursday, so "kal" is Friday 25 Sep.
 * ------------------------------------------------------------------------- */

const TODAY = "2026-09-24";
const WORKING = {
  timezone: "Asia/Kolkata",
  dayBoundaryHour: 0,
  workingDays: [1, 2, 3, 4, 5, 6],
};

function reading(over: Partial<CallReading>): CallReading {
  return {
    summary: "",
    direction: "unclear",
    reached: "spoke",
    noAnswerReason: null,
    intents: [],
    feedback: [],
    order: { commitment: "none", lines: [] },
    complaint: null,
    notInterested: null,
    noOrder: null,
    opportunity: null,
    sample: null,
    payment: null,
    followUp: null,
    nextSteps: [],
    casual: null,
    inbound: null,
    doNotCall: { said: false, quote: null },
    unclear: [],
    ...over,
  };
}

type Cue = NonNullable<NonNullable<CallReading["followUp"]>["when"]>;
function cue(phrase: string, over: Partial<Cue>): Cue {
  return {
    phrase,
    kind: "unclear",
    n: null,
    weekday: null,
    which: null,
    day: null,
    month: null,
    date: null,
    ...over,
  };
}

function input(over: Partial<DecideInput>): DecideInput {
  return {
    reading: null,
    text: "",
    classifier: null,
    today: TODAY,
    working: WORKING,
    existing: { reminders: [], complaints: [], opportunities: [], samples: [] },
    products: {},
    customer: { doNotContact: false },
    config: {
      confirmBelow: 70,
      classifierVetoAt: 0.85,
      noAnswerRetryWorkingDays: 1,
      duplicateWindowDays: 7,
    },
    ...over,
  };
}

type Step = NonNullable<CallReading["nextSteps"]>[number];
const step = (action: string, when: Step["when"] = null, evidence = ""): Step => ({
  action,
  when,
  evidence,
});
const KAL = () => cue("kal", { kind: "tomorrow" });

/** A follow-up call whose telecaller also said what they will do. */
function followUpCall(
  steps: Step[],
  text = "kal customer ko call back karna hai",
) {
  return decideCallActions(
    input({
      text,
      reading: reading({
        intents: [{ intent: "follow_up", confidence: 90, evidence: "kal call" }],
        followUp: { reason: null, when: KAL() },
        nextSteps: steps,
      }),
    }),
  );
}

test("a clearly spoken next action fills its chip and its day", () => {
  const a = followUpCall([step("call_back", KAL(), "kal call karna hai")]);
  assert.equal(a.primary?.fill?.outcome, "follow_up");
  assert.deepEqual(a.primary?.fill?.nextActions, ["call_back"]);
  assert.equal(a.primary?.fill?.nextActionDate, "2026-09-25");
  assert.equal(a.primary?.fill?.nextActionNote, undefined);
  /* The outcome's own date is untouched — the two are deduplicated on save. */
  assert.equal(a.primary?.fill?.followUpDate, "2026-09-25");
  assert.equal(a.primary?.state, "ready", "a next action never demotes the outcome");
});

test("an action this outcome does not offer is not put on the form", () => {
  /* follow_up's list has no payment chase, no order confirmation, no 'nothing'. */
  for (const action of ["follow_up_payment", "confirm_order", "no_follow_up"]) {
    const a = followUpCall([step(action, KAL())]);
    assert.equal(a.primary?.fill?.nextActions, undefined, action);
    assert.equal(a.primary?.fill?.nextActionDate, undefined, action);
  }
  /* A valid one beside an invalid one keeps only the valid one. */
  const mixed = followUpCall([
    step("follow_up_payment", KAL()),
    step("send_quotation", KAL()),
  ]);
  assert.deepEqual(mixed.primary?.fill?.nextActions, ["send_quotation"]);
});

test("the same words are valid on one outcome and not on another", () => {
  const spoken = [step("follow_up_payment", KAL())];
  const orderTaken = decideCallActions(
    input({
      text: "order confirmed 20 cans nano, payment follow up kal",
      reading: reading({
        intents: [{ intent: "order_received", confidence: 95, evidence: "order" }],
        order: {
          commitment: "confirmed",
          lines: [{ product: "nano", quantity: 20, unit: "cans" }],
        },
        nextSteps: spoken,
      }),
      products: {
        nano: { state: "matched", productId: "p1", name: "Nano Thinner" },
      },
    }),
  );
  assert.deepEqual(orderTaken.primary?.fill?.nextActions, ["follow_up_payment"]);
  assert.equal(followUpCall(spoken).primary?.fill?.nextActions, undefined);
});

test("an ambiguous day is not forced — the action goes in, the day does not", () => {
  const a = followUpCall([
    step(
      "call_back",
      cue("next Friday", { kind: "weekday", weekday: 5, which: "next" }),
    ),
  ]);
  assert.deepEqual(a.primary?.fill?.nextActions, ["call_back"]);
  assert.equal(a.primary?.fill?.nextActionDate, undefined);
  assert.ok(a.primary?.fill?.nextActionNote, "says why the day is left");
});

test("a day that has already gone is not forced", () => {
  const a = followUpCall([
    step("call_back", cue("1 Sep", { kind: "absolute", date: "2026-09-01" })),
  ]);
  assert.deepEqual(a.primary?.fill?.nextActions, ["call_back"]);
  assert.equal(a.primary?.fill?.nextActionDate, undefined);
  assert.ok(a.primary?.fill?.nextActionNote);
});

test("a dated action with no day named leaves the day for the telecaller", () => {
  const a = followUpCall([step("send_quotation", null)]);
  assert.deepEqual(a.primary?.fill?.nextActions, ["send_quotation"]);
  assert.equal(a.primary?.fill?.nextActionDate, undefined);
  assert.ok(a.primary?.fill?.nextActionNote);
});

test("two actions for two different days fill neither day", () => {
  const a = followUpCall([
    step("call_back", KAL()),
    step(
      "send_quotation",
      cue("Monday", { kind: "weekday", weekday: 1, which: "this" }),
    ),
  ]);
  assert.deepEqual(a.primary?.fill?.nextActions, ["call_back", "send_quotation"]);
  assert.equal(a.primary?.fill?.nextActionDate, undefined);
});

test("silence never produces a next action — in particular never no_follow_up", () => {
  assert.equal(followUpCall([]).primary?.fill?.nextActions, undefined);

  /* A reading stored before the field existed has no list at all. */
  const old = reading({
    intents: [{ intent: "follow_up", confidence: 90, evidence: "" }],
    followUp: { reason: null, when: KAL() },
  }) as Partial<CallReading>;
  delete old.nextSteps;
  const fromOld = decideCallActions(input({ text: "x", reading: old as CallReading }));
  assert.equal(fromOld.primary?.fill?.nextActions, undefined);

  const noOrder = (text: string, said = false) =>
    decideCallActions(
      input({
        text,
        reading: reading({
          intents: [{ intent: "no_order", confidence: 90, evidence: "no order" }],
          noOrder: { reason: "not_required", when: null },
          doNotCall: { said, quote: null },
          nextSteps: [step("no_follow_up")],
        }),
      }),
    );
  assert.equal(
    noOrder("customer said no order today").primary?.fill?.nextActions,
    undefined,
    "the model alone cannot say it",
  );
  assert.equal(
    noOrder("nothing further, do not call again", true).primary?.fill?.nextActions,
    undefined,
    "never beside a do-not-call",
  );
});

test("an explicit 'nothing further' can produce no_follow_up, with no day", () => {
  for (const text of [
    "no order today, nothing further needed",
    "abhi kuch nahi karna",
    "no follow-up required",
  ]) {
    const a = decideCallActions(
      input({
        text,
        reading: reading({
          intents: [{ intent: "no_order", confidence: 90, evidence: text }],
          noOrder: { reason: "not_required", when: null },
          nextSteps: [step("no_follow_up", null, text)],
        }),
      }),
    );
    assert.deepEqual(a.primary?.fill?.nextActions, ["no_follow_up"], text);
    assert.equal(a.primary?.fill?.nextActionDate, undefined, text);
  }
});

test("no_follow_up beside another action is refused whole, and says so", () => {
  const a = decideCallActions(
    input({
      text: "nothing further needed, but call back kal",
      reading: reading({
        intents: [{ intent: "no_order", confidence: 90, evidence: "" }],
        noOrder: { reason: "not_required", when: KAL() },
        nextSteps: [step("no_follow_up"), step("call_back", KAL())],
      }),
    }),
  );
  assert.equal(a.primary?.fill?.nextActions, undefined);
  assert.ok(a.primary?.fill?.nextActionNote);
});

test("the rules read 'nothing further' but not a do-not-call", () => {
  assert.ok(readNothingFurther("nothing further is needed").found);
  assert.ok(readNothingFurther("koi follow up nahi").found);
  assert.equal(readNothingFurther("no more calls please").found, false);
  assert.equal(readNothingFurther("will call back tomorrow").found, false);
});

test("an outcome with no action list takes none, however it was said", () => {
  /* An outbound no-answer has no Next Action question at all. */
  const a = decideCallActions(
    input({
      text: "NR, kal call karna",
      reading: reading({
        reached: "no_answer",
        intents: [{ intent: "no_answer", confidence: 90, evidence: "NR" }],
        nextSteps: [step("call_back", KAL())],
      }),
    }),
  );
  assert.equal(a.primary?.fill?.outcome, "no_answer");
  assert.equal(a.primary?.fill?.nextActions, undefined);
});

test("a call-back said into Next Action is not also offered as a reminder button", () => {
  const read = (steps: Step[]) =>
    decideCallActions(
      input({
        text: "no order, price issue. kal call karna hai",
        reading: reading({
          intents: [
            { intent: "no_order", confidence: 90, evidence: "no order" },
            { intent: "follow_up", confidence: 70, evidence: "kal call" },
          ],
          noOrder: { reason: "price_issue", when: KAL() },
          followUp: { reason: null, when: KAL() },
          nextSteps: steps,
        }),
      }),
    );
  const without = read([]);
  assert.equal(without.primary?.intent, "no_order");
  assert.ok(
    without.extras.some((e) => e.key === "reminder-follow_up"),
    "control: with nothing in Next Action the button is still offered",
  );
  const withStep = read([step("call_back", KAL())]);
  assert.deepEqual(withStep.primary?.fill?.nextActions, ["call_back"]);
  assert.ok(!withStep.extras.some((e) => e.key === "reminder-follow_up"));
});
