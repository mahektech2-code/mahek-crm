import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDateCues,
  resolveDateCue,
  crossCheckPhrase,
} from "./call-intel-dates";
import { parseAmounts, readSignals } from "./call-intel-signals";
import {
  crossValidate,
  predict,
  tokenize,
  train,
} from "./call-intel-classifier";
import { decideCallActions, type DecideInput } from "./call-intel-decide";
import type { CallReading } from "@/lib/call-intel-schema";

/* ---------------------------------------------------------------------------
 * THE CALL ASSISTANT — the client's rules, one test each where they can be.
 *
 * 24 Sep 2026 is a Thursday; Mahek works Monday to Saturday.
 * ------------------------------------------------------------------------- */

const TODAY = "2026-09-24";
const WORKING = {
  timezone: "Asia/Kolkata",
  dayBoundaryHour: 0,
  workingDays: [1, 2, 3, 4, 5, 6],
};

/* ------------------------------------------------------------------ dates */

test("'after 15 days' is a real date, moved off a Sunday", () => {
  const r = resolveDateCue({ kind: "in_days", n: 15 }, TODAY, WORKING);
  assert.equal(r.date, "2026-10-09"); // Friday
  assert.equal(r.movedFrom, null);
  const sunday = resolveDateCue({ kind: "in_days", n: 3 }, TODAY, WORKING); // Sun 27
  assert.equal(sunday.movedFrom, "2026-09-27");
  assert.equal(sunday.date, "2026-09-28");
});

test("'next Monday' on a Thursday has one answer; 'next Friday' has two", () => {
  const monday = resolveDateCue(
    { kind: "weekday", weekday: 1, which: "next" },
    TODAY,
    WORKING,
  );
  assert.equal(monday.date, "2026-09-28");
  assert.equal(monday.alternative, null);

  const friday = resolveDateCue(
    { kind: "weekday", weekday: 5, which: "next" },
    TODAY,
    WORKING,
  );
  assert.equal(friday.date, "2026-09-25");
  assert.equal(
    friday.alternative,
    "2026-10-02",
    "both readings are offered, neither is picked",
  );

  const thisFriday = resolveDateCue(
    { kind: "weekday", weekday: 5, which: "this" },
    TODAY,
    WORKING,
  );
  assert.equal(thisFriday.date, "2026-09-25");
  assert.equal(thisFriday.alternative, null);
});

test("month end is a deadline and moves BACK off a day nobody works", () => {
  /* 31 Oct 2026 is a Saturday (worked); 31 May 2026 is a Sunday. */
  const may = resolveDateCue({ kind: "month_end" }, "2026-05-10", WORKING);
  assert.equal(may.date, "2026-05-30");
});

test("'the 20th' said on the 24th is next month's", () => {
  const r = resolveDateCue(
    { kind: "day_of_month", day: 20, month: null },
    TODAY,
    WORKING,
  );
  assert.equal(r.date, "2026-10-20");
  const named = resolveDateCue(
    { kind: "day_of_month", day: 5, month: 1 },
    TODAY,
    WORKING,
  );
  assert.equal(
    named.date,
    "2027-01-05",
    "a named month already gone is next year's",
  );
});

test("a date in the past is flagged, never accepted quietly", () => {
  const r = resolveDateCue(
    { kind: "absolute", date: "2026-09-01" },
    TODAY,
    WORKING,
  );
  assert.equal(r.past, true);
});

test("the words are read in English, Hinglish and Devanagari", () => {
  const kinds = (t: string) => parseDateCues(t).map((c) => c.cue);
  assert.deepEqual(kinds("call after 15 days"), [{ kind: "in_days", n: 15 }]);
  assert.deepEqual(kinds("15 din baad call karna"), [
    { kind: "in_days", n: 15 },
  ]);
  assert.deepEqual(kinds("do hafte me payment"), [{ kind: "in_weeks", n: 2 }]);
  assert.deepEqual(kinds("15 दिन बाद फोन करना"), [{ kind: "in_days", n: 15 }]);
  assert.deepEqual(kinds("agle somvar ko"), [
    { kind: "weekday", weekday: 1, which: "next" },
  ]);
  assert.deepEqual(kinds("parso payment karenge"), [
    { kind: "day_after_tomorrow" },
  ]);
  assert.deepEqual(kinds("call day after tomorrow"), [
    { kind: "day_after_tomorrow" },
  ]);
  assert.deepEqual(kinds("payment 20 tarikh ko"), [
    { kind: "day_of_month", day: 20, month: null },
  ]);
  assert.deepEqual(kinds("mahine ke end tak"), [{ kind: "month_end" }]);
  assert.deepEqual(kinds("5th october"), [
    { kind: "day_of_month", day: 5, month: 10 },
  ]);
});

test("a bare 'do' or 'sat' is not a weekday", () => {
  assert.deepEqual(parseDateCues("sample bhej do"), []);
  assert.deepEqual(parseDateCues("I sat with him"), []);
});

test("the cross-check reads the model's quoted phrase itself", () => {
  assert.equal(crossCheckPhrase("15 din baad", TODAY, WORKING), "2026-10-09");
  assert.equal(crossCheckPhrase("whenever", TODAY, WORKING), null);
});

/* -------------------------------------------------------------- signals */

test("do-not-call is heard in all three scripts", () => {
  assert.ok(
    readSignals("Customer said don't call again, not interested").doNotCall
      .found,
  );
  assert.ok(readSignals("bola phone mat karo dobara").doNotCall.found);
  assert.ok(readSignals("उन्होंने कहा फोन मत करो").doNotCall.found);
  assert.equal(readSignals("will call again next week").doNotCall.found, false);
});

test("a missed call is heard, and 'busy this week' is not one", () => {
  assert.ok(readSignals("NR").noAnswer.found);
  assert.ok(readSignals("phone switch off tha").noAnswer.found);
  assert.ok(readSignals("call not picked").noAnswer.found);
  assert.equal(
    readSignals("he is busy this week, call Monday").noAnswer.found,
    false,
  );
});

test("maybe is heard, and a placed order is not a maybe", () => {
  assert.ok(readSignals("I may order next week").tentative.found);
  assert.ok(readSignals("shayad agle hafte order denge").tentative.found);
  assert.ok(
    readSignals("order confirmed, 20 cans nano thinner").firmOrder.found,
  );
});

test("money is read in Indian words, and a bare count is not money", () => {
  assert.deepEqual(parseAmounts("50 hazar friday tak"), [50000]);
  assert.deepEqual(parseAmounts("1.5 lakh by month end"), [150000]);
  assert.deepEqual(parseAmounts("₹25,000 NEFT"), [25000]);
  assert.deepEqual(parseAmounts("Rs 12000 cheque"), [12000]);
  assert.deepEqual(parseAmounts("20 cans nano, 15 days"), []);
});

/* ----------------------------------------------------------- classifier */

const EXAMPLES = [
  ...[
    "NR",
    "not picked",
    "switch off",
    "phone not reachable",
    "call not picked NR",
    "ringing no response",
  ].map((text) => ({ text, label: "no_answer" })),
  ...[
    "order given 20 cans nano thinner",
    "order confirmed dispatch today",
    "order diya 10 can",
    "po received send material",
  ].map((text) => ({ text, label: "order_taken" })),
  ...[
    "payment friday tak",
    "will pay 50000 next week",
    "payment karenge monday",
    "cheque dega 5 tarikh",
  ].map((text) => ({ text, label: "payment_promised" })),
  ...[
    "stock available no order",
    "rate jyada hai no order",
    "abhi requirement nahi",
    "stock hai abhi",
  ].map((text) => ({ text, label: "no_order" })),
];

test("the classifier learns the office's shorthand", () => {
  const model = train(EXAMPLES, { minTokenCount: 1 });
  assert.equal(predict(model, "NR switch off")[0].label, "no_answer");
  assert.equal(
    predict(model, "payment monday tak karenge")[0].label,
    "payment_promised",
  );
  assert.equal(predict(model, "order diya 20 can")[0].label, "order_taken");
  const total = predict(model, "anything").reduce(
    (s, p) => s + p.probability,
    0,
  );
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("numbers collapse, and the model survives a JSON round trip", () => {
  assert.ok(tokenize("15 din baad").includes("#_din"));
  const model = JSON.parse(
    JSON.stringify(train(EXAMPLES, { minTokenCount: 1 })),
  );
  assert.equal(predict(model, "not picked")[0].label, "no_answer");
});

test("cross-validation reports per-label figures", () => {
  const e = crossValidate([...EXAMPLES, ...EXAMPLES], { folds: 3 });
  assert.equal(e.examples, EXAMPLES.length * 2);
  assert.ok(e.accuracy > 0.5);
  assert.ok(e.perLabel.no_answer.support > 0);
});

/* ---------------------------------------------------------------- decide */

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
    casual: null,
    doNotCall: { said: false, quote: null },
    unclear: [],
    ...over,
  };
}

function cue(
  phrase: string,
  over: Partial<CallReading["payment"] & object> & Record<string, unknown>,
) {
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
  } as NonNullable<NonNullable<CallReading["payment"]>["when"]>;
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

test("'I may order next week' is an opportunity, never an order", () => {
  const a = decideCallActions(
    input({
      text: "Customer said I may order next week, 20 cans nano",
      reading: reading({
        intents: [
          {
            intent: "order_received",
            confidence: 90,
            evidence: "may order next week",
          },
        ],
        order: {
          commitment: "confirmed",
          lines: [{ product: "nano", quantity: 20, unit: "cans" }],
        },
        opportunity: {
          product: "nano",
          quantity: "20 cans",
          valueRupees: null,
          when: cue("next week", { kind: "next_week" }),
        },
      }),
      products: {
        nano: {
          state: "matched",
          productId: "p1",
          name: "Nano Thinner - 20 Liter",
        },
      },
    }),
  );
  assert.equal(a.primary?.intent, "opportunity");
  assert.equal(a.primary?.fill?.outcome, "follow_up");
  assert.equal(a.primary?.fill?.followUpDate, "2026-09-28");
  assert.equal(
    a.primary?.fill?.opportunity?.product,
    "Nano Thinner - 20 Liter",
  );
  assert.match(a.primary!.why, /not an order/);
});

test("a confirmed order fills the lines and asks about what it could not match", () => {
  const a = decideCallActions(
    input({
      text: "order confirmed 20 cans nano thinner and 5 cans of xyz primer",
      reading: reading({
        intents: [
          {
            intent: "order_received",
            confidence: 95,
            evidence: "order confirmed",
          },
        ],
        order: {
          commitment: "confirmed",
          lines: [
            { product: "nano thinner", quantity: 20, unit: "cans" },
            { product: "xyz primer", quantity: 5, unit: "cans" },
          ],
        },
      }),
      products: {
        "nano thinner": {
          state: "matched",
          productId: "p1",
          name: "Nano Thinner - 20 Liter",
        },
        "xyz primer": { state: "none" },
      },
    }),
  );
  assert.equal(a.primary?.fill?.outcome, "order_taken");
  assert.deepEqual(a.primary?.fill?.orderLines, [
    { productId: "p1", name: "Nano Thinner - 20 Liter", quantity: 20 },
  ]);
  assert.equal(a.primary?.state, "confirm");
  assert.ok(a.primary?.questions.some((q) => q.includes("xyz primer")));
});

test("a payment promise gets a real date and a cross-checked amount", () => {
  const a = decideCallActions(
    input({
      text: "15 din baad 50 hazar payment karenge",
      reading: reading({
        intents: [
          {
            intent: "payment_promised",
            confidence: 92,
            evidence: "15 din baad payment",
          },
        ],
        payment: {
          amountRupees: 50000,
          mode: null,
          when: cue("15 din baad", { kind: "in_days", n: 15 }),
        },
      }),
    }),
  );
  assert.equal(a.primary?.state, "ready");
  assert.equal(a.primary?.fill?.payDate, "2026-10-09");
  assert.equal(a.primary?.fill?.payAmountRupees, 50000);
  assert.equal(a.primary?.fill?.outcomeDetail.promisedAmount, "50000");
});

test("an amount the rules read differently is asked, not settled", () => {
  const a = decideCallActions(
    input({
      text: "5 hazar payment kal",
      reading: reading({
        intents: [
          {
            intent: "payment_promised",
            confidence: 92,
            evidence: "payment kal",
          },
        ],
        payment: {
          amountRupees: 50000,
          mode: null,
          when: cue("kal", { kind: "tomorrow" }),
        },
      }),
    }),
  );
  assert.equal(a.primary?.state, "confirm");
  assert.ok(a.primary?.questions.some((q) => q.includes("₹5,000")));
});

test("a date the model and the rules read differently is left empty with both offered", () => {
  const a = decideCallActions(
    input({
      text: "call after 15 days",
      reading: reading({
        intents: [
          {
            intent: "follow_up",
            confidence: 90,
            evidence: "call after 15 days",
          },
        ],
        followUp: {
          reason: "customer_asked_later",
          when: cue("after 15 days", { kind: "in_days", n: 10 }),
        },
      }),
    }),
  );
  assert.equal(a.primary?.fill?.followUpDate, undefined);
  assert.deepEqual(a.primary?.date?.choices.map((c) => c.date).sort(), [
    "2026-10-05",
    "2026-10-09",
  ]);
  assert.equal(a.primary?.state, "confirm");
});

test("no day said is a question with suggestions, never a default filled in", () => {
  const a = decideCallActions(
    input({
      reading: reading({
        intents: [
          { intent: "follow_up", confidence: 90, evidence: "call later" },
        ],
        followUp: { reason: "customer_asked_later", when: null },
      }),
    }),
  );
  assert.equal(a.primary?.fill?.followUpDate, undefined);
  assert.ok((a.primary?.date?.choices.length ?? 0) > 0);
  assert.equal(a.primary?.state, "confirm");
});

test("low confidence asks, with the candidates as choices", () => {
  const a = decideCallActions(
    input({
      reading: reading({
        intents: [
          { intent: "no_order", confidence: 50, evidence: "not now" },
          { intent: "follow_up", confidence: 45, evidence: "call later" },
        ],
      }),
    }),
  );
  assert.equal(a.primary?.state, "confirm");
  assert.ok(a.alternatives.length >= 2);
});

test("a confident classifier that disagrees turns the answer into a question", () => {
  const a = decideCallActions(
    input({
      reading: reading({
        intents: [
          { intent: "casual_talk", confidence: 90, evidence: "talked" },
        ],
      }),
      classifier: [
        { label: "no_order", probability: 0.93 },
        { label: "casual_talk", probability: 0.07 },
      ],
    }),
  );
  assert.equal(a.primary?.state, "confirm");
  assert.deepEqual(a.alternatives.map((x) => x.outcome).sort(), [
    "casual_talk",
    "no_order",
  ]);
  assert.equal(a.readers.agreed, false);
});

test("do-not-call is shown when either reader hears it, and is never filled in", () => {
  const a = decideCallActions(
    input({
      text: "bola phone mat karo, not interested, buying from Asian",
      reading: reading({
        intents: [
          {
            intent: "not_interested",
            confidence: 95,
            evidence: "not interested",
          },
        ],
        notInterested: {
          reason: "buying_competitor",
          competitor: "Asian",
          futureOpportunity: "never",
          when: null,
        },
        doNotCall: { said: false, quote: null },
      }),
    }),
  );
  assert.equal(a.doNotCall?.heardBy, "rules");
  assert.equal(a.primary?.fill?.outcomeDetail.futureOpportunity, undefined);
  assert.equal(a.primary?.fill?.outcomeDetail.competitorName, "Asian");
});

test("no answer suggests a retry reminder on the next working day", () => {
  const a = decideCallActions(
    input({
      text: "NR switch off",
      reading: reading({ reached: "no_answer", intents: [] }),
    }),
  );
  assert.equal(a.primary?.intent, "no_answer");
  assert.equal(a.primary?.fill?.outcomeDetail.whyNoAnswer, "switched_off");
  const retry = a.extras.find((e) => e.key === "retry");
  assert.equal(retry?.reminder?.dueDate, "2026-09-25");
  assert.equal(retry?.door, "reminder");
});

test("an open reminder for about the same day is a duplicate, offered as a move", () => {
  const a = decideCallActions(
    input({
      text: "NR",
      reading: reading({ reached: "no_answer" }),
      existing: {
        reminders: [
          {
            id: "rem1",
            dueDate: "2026-09-26",
            note: "call back",
            type: "call_back",
          },
        ],
        complaints: [],
        opportunities: [],
        samples: [],
      },
    }),
  );
  const retry = a.extras.find((e) => e.key === "retry");
  assert.equal(retry?.state, "duplicate");
  assert.equal(retry?.door, "reschedule");
  assert.equal(retry?.duplicateOf?.id, "rem1");
});

test("an open complaint of the same kind is named rather than raised twice", () => {
  const a = decideCallActions(
    input({
      reading: reading({
        intents: [
          { intent: "complaint", confidence: 90, evidence: "drum leaking" },
        ],
        complaint: {
          category: "packaging_damage",
          description: "Drum leaking",
          requiredAction: "replacement",
          creditNoteAsked: false,
        },
      }),
      existing: {
        reminders: [],
        complaints: [
          {
            id: "cmp1",
            category: "packaging_damage",
            description: "Two cans dented",
            createdAt: "2026-09-20T10:00:00Z",
          },
        ],
        opportunities: [],
        samples: [],
      },
    }),
  );
  assert.equal(a.primary?.state, "duplicate");
  assert.equal(a.primary?.duplicateOf?.id, "cmp1");
});

test("a sample request is its own door, and an open one is named", () => {
  const a = decideCallActions(
    input({
      reading: reading({
        intents: [
          {
            intent: "sample_required",
            confidence: 90,
            evidence: "sample bhejo",
          },
        ],
        sample: {
          product: "PU sealer",
          quantityCans: 2,
          application: "wood furniture",
        },
      }),
      products: {
        "PU sealer": {
          state: "matched",
          productId: "p9",
          name: "PU Sealer - 4 Liter",
        },
      },
      existing: {
        reminders: [],
        complaints: [],
        opportunities: [],
        samples: [
          {
            id: "smp1",
            productName: "PU Sealer - 4 Liter",
            state: "dispatched",
            requestedAt: "2026-09-10",
          },
        ],
      },
    }),
  );
  assert.equal(a.primary?.fill?.outcomeDetail.followUpReason, "waiting_sample");
  const sample = a.extras.find((e) => e.door === "sample");
  assert.equal(sample?.state, "duplicate");
});

test("two things on one call: the order is filed, the complaint gets its own door", () => {
  const a = decideCallActions(
    input({
      text: "order confirmed 10 cans, also last drum was leaking",
      reading: reading({
        intents: [
          { intent: "complaint", confidence: 85, evidence: "drum leaking" },
          {
            intent: "order_received",
            confidence: 95,
            evidence: "order confirmed",
          },
        ],
        order: {
          commitment: "confirmed",
          lines: [{ product: "nano", quantity: 10, unit: "cans" }],
        },
        complaint: {
          category: "packaging_damage",
          description: "Drum leaking",
          requiredAction: null,
          creditNoteAsked: false,
        },
      }),
      products: { nano: { state: "matched", productId: "p1", name: "Nano" } },
    }),
  );
  assert.equal(a.primary?.intent, "order_received");
  assert.equal(
    a.extras.find((e) => e.door === "complaint")?.fill?.complaint?.category,
    "packaging_damage",
  );
});

test("with no language model, the classifier points at a form and ASKS", () => {
  const a = decideCallActions(
    input({
      text: "NR",
      classifier: [{ label: "no_answer", probability: 0.97 }],
    }),
  );
  assert.equal(a.primary?.intent, "no_answer");
  assert.equal(a.primary?.state, "confirm");
  assert.equal(a.readers.model, false);
});

/* -------------------------------------------------------------- products */

import { chooseProduct } from "./call-intel-products";

test("what the customer bought before settles 'nano'; otherwise several rows ask", () => {
  const rows = [
    { productId: "a", name: "Nano Thinner - 5 Liter", boughtBefore: false },
    { productId: "b", name: "Nano Thinner - 20 Liter", boughtBefore: true },
    {
      productId: "c",
      name: "Astar Nano Thinner - 20 Liter",
      boughtBefore: false,
    },
  ];
  assert.deepEqual(chooseProduct("nano", rows), {
    state: "matched",
    productId: "b",
    name: "Nano Thinner - 20 Liter",
  });
  const fresh = rows.map((r) => ({ ...r, boughtBefore: false }));
  assert.equal(chooseProduct("nano", fresh).state, "ambiguous");
  assert.equal(chooseProduct("nano thinner - 5 liter", fresh).state, "matched");
  assert.equal(chooseProduct("xyz", []).state, "none");
});
