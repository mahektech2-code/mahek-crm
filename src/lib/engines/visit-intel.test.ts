import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideVisitActions,
  type VisitAction,
  type VisitDecideInput,
} from "./visit-intel-decide";
import {
  HANDSET_COMPLAINT_CATEGORIES,
  HANDSET_PAY_MODES,
  type VisitReading,
} from "@/lib/visit-intel-schema";
import { VISIT_OUTCOMES } from "@/lib/visit-intel-labels";

/* ---------------------------------------------------------------------------
 * THE VISIT ASSISTANT — the client's rules, applied to a shop visit.
 *
 * 24 Sep 2026 is a Thursday; Mahek works Monday to Saturday.
 * ------------------------------------------------------------------------- */

const TODAY = "2026-09-24";
const WORKING = {
  timezone: "Asia/Kolkata",
  dayBoundaryHour: 0,
  workingDays: [1, 2, 3, 4, 5, 6],
};

function reading(over: Partial<VisitReading> = {}): VisitReading {
  return {
    summary: "Met the owner.",
    met: "decision_maker",
    shop: "open",
    intents: [],
    order: { commitment: "none", lines: [] },
    payment: null,
    complaint: null,
    sample: null,
    opportunity: null,
    requirement: null,
    leadVerdict: null,
    competitor: null,
    comeBack: null,
    feedback: [],
    unclear: [],
    ...over,
  };
}

function input(
  r: VisitReading | null,
  text: string,
  over: Partial<VisitDecideInput> = {},
): VisitDecideInput {
  return {
    reading: r,
    text,
    today: TODAY,
    working: WORKING,
    existing: { complaints: [], samples: [] },
    products: {},
    customer: { isLead: false, decisionDue: false },
    sampleReasonCodes: ["comparison", "new_application"],
    config: { confirmBelow: 70 },
    ...over,
  };
}

const action = <K extends VisitAction["kind"]>(
  actions: VisitAction[],
  kind: K,
) => actions.find((a) => a.kind === kind) as Extract<VisitAction, { kind: K }>;

/* ------------------------------------------------------------------ order */

test("a confirmed order fills the order chip and the cart lines", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [
          { intent: "order_taken", confidence: 92, evidence: "10 nano de do" },
        ],
        order: {
          commitment: "confirmed",
          lines: [{ product: "nano", quantity: 10, unit: "unknown" }],
        },
      }),
      "Order diya, 10 nano de do",
      {
        products: {
          nano: { state: "matched", productId: "p1", name: "Nano Thinner 5L" },
        },
      },
    ),
  );
  assert.equal(a.outcome?.key, "order");
  assert.equal(a.outcome?.state, "ready");
  const order = action(a.actions, "order");
  assert.equal(order.state, "ready");
  assert.equal(order.lines[0].quantityCans, 10);
});

test("'will order next week' is a date to come back, never an order", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [
          { intent: "order_taken", confidence: 80, evidence: "next week order" },
        ],
        order: { commitment: "tentative", lines: [] },
        opportunity: {
          product: null,
          when: {
            phrase: "next week",
            kind: "next_week",
            n: null,
            weekday: null,
            which: null,
            day: null,
            month: null,
            date: null,
          },
        },
      }),
      "Maybe next week order karenge",
    ),
  );
  assert.notEqual(a.outcome?.key, "order");
  assert.equal(action(a.actions, "order"), undefined);
  assert.ok(action(a.actions, "opportunity"), "a maybe is kept as a maybe");
  assert.ok(a.comeBack?.date, "the maybe's day becomes the day to come back");
  assert.ok(a.notes.some((n) => /Not an order/.test(n)));
});

test("litres are asked about, never turned into cans", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [{ intent: "order_taken", confidence: 90, evidence: "" }],
        order: {
          commitment: "confirmed",
          lines: [{ product: "PU sealer", quantity: 40, unit: "litres" }],
        },
      }),
      "PU sealer 40 litre order",
      {
        products: {
          "PU sealer": { state: "matched", productId: "p2", name: "PU Sealer 20L" },
        },
      },
    ),
  );
  const order = action(a.actions, "order");
  assert.equal(order.lines[0].quantityCans, null);
  assert.equal(order.state, "confirm");
  assert.ok(order.questions.some((q) => /how many cans/.test(q)));
});

/* ------------------------------------------------------------------ money */

test("money handed over is a receipt; money promised is a day", () => {
  const paid = decideVisitActions(
    input(
      reading({
        intents: [
          { intent: "payment_collected", confidence: 90, evidence: "20 hazar cash" },
        ],
        payment: {
          collectedRupees: 20000,
          mode: "Cash",
          promisedRupees: null,
          when: null,
        },
      }),
      "20 hazar cash diya",
    ),
  );
  assert.equal(paid.outcome?.key, "payment");
  const pay = action(paid.actions, "payment");
  assert.equal(pay.amountRupees, 20000);
  assert.equal(pay.mode, "Cash");
  assert.equal(pay.state, "ready");

  const promised = decideVisitActions(
    input(
      reading({
        intents: [
          { intent: "payment_promised", confidence: 88, evidence: "Monday dega" },
        ],
        payment: {
          collectedRupees: null,
          mode: null,
          promisedRupees: 50000,
          when: {
            phrase: "Monday",
            kind: "weekday",
            n: null,
            weekday: 1,
            which: "this",
            day: null,
            month: null,
            date: null,
          },
        },
      }),
      "50 hazar Monday ko dega",
    ),
  );
  assert.equal(
    promised.outcome?.key,
    "visited",
    "nothing was paid, so the payment chip would claim cash that is not there",
  );
  assert.equal(action(promised.actions, "payment"), undefined);
  assert.equal(action(promised.actions, "promise").amountRupees, 50000);
  assert.equal(promised.comeBack?.date, "2026-09-28");
});

test("an amount the words disagree with is asked, not filled", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [{ intent: "payment_collected", confidence: 90, evidence: "" }],
        payment: {
          collectedRupees: 5000,
          mode: "Cash",
          promisedRupees: null,
          when: null,
        },
      }),
      "50 hazar cash liya",
    ),
  );
  const pay = action(a.actions, "payment");
  assert.equal(pay.state, "confirm");
  assert.ok(pay.questions.some((q) => /₹5,000 or ₹50,000/.test(q)));
});

test("no mode means the chip is asked for", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [{ intent: "payment_collected", confidence: 90, evidence: "" }],
        payment: {
          collectedRupees: 12000,
          mode: null,
          promisedRupees: null,
          when: null,
        },
      }),
      "Rs 12000 collected",
    ),
  );
  assert.equal(action(a.actions, "payment").state, "confirm");
});

/* ------------------------------------------------------- nobody, and unsure */

test("nobody there files the empty shop and drops what a staff member guessed", () => {
  const a = decideVisitActions(
    input(
      reading({
        met: "nobody",
        intents: [
          { intent: "owner_not_available", confidence: 85, evidence: "malik nahi the" },
          { intent: "order_taken", confidence: 60, evidence: "boy said order" },
        ],
        order: { commitment: "tentative", lines: [] },
      }),
      "Malik nahi the, boy bola order denge",
    ),
  );
  assert.equal(a.outcome?.key, "closed_now");
  assert.equal(action(a.actions, "order"), undefined);
});

test("two strong intents on different chips ask which", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [
          { intent: "complaint", confidence: 85, evidence: "leak in drum" },
          { intent: "sample_required", confidence: 82, evidence: "sample chahiye" },
        ],
        complaint: {
          category: "Leakage / Packaging",
          description: "Drum leaking",
          urgent: false,
        },
        sample: {
          product: null,
          quantityCans: null,
          application: null,
          reasonCode: null,
        },
      }),
      "Drum leak hai, aur sample chahiye",
    ),
  );
  assert.equal(a.outcome?.state, "confirm");
  const keys = a.outcomeChoices.map((c) => c.key);
  assert.ok(keys.includes("complaint") && keys.includes("sample"));
  /* Both still get their doors, whichever chip he picks. */
  assert.ok(action(a.actions, "complaint"));
  assert.ok(action(a.actions, "sample"));
});

test("a weak reading asks rather than fills", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [{ intent: "sample_required", confidence: 50, evidence: "" }],
      }),
      "shayad sample",
    ),
  );
  assert.equal(a.outcome?.state, "confirm");
  assert.ok(a.outcomeChoices.some((c) => c.key === "visited"));
});

/* ---------------------------------------------------------- nothing twice */

test("an open complaint in the same category is named, not raised again", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [{ intent: "complaint", confidence: 90, evidence: "" }],
        complaint: {
          category: "Delivery Delay",
          description: "Late again",
          urgent: false,
        },
      }),
      "Delivery late again",
      {
        existing: {
          complaints: [
            { id: "c1", category: "Delivery Delay", description: "Late by 4 days" },
          ],
          samples: [],
        },
      },
    ),
  );
  const c = action(a.actions, "complaint");
  assert.equal(c.state, "duplicate");
  assert.equal(c.duplicateOf, "c1");
});

test("an open sample of the same product is named, not requested again", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [{ intent: "sample_required", confidence: 90, evidence: "" }],
        sample: {
          product: "Nano thinner",
          quantityCans: 1,
          application: "furniture",
          reasonCode: "comparison",
        },
      }),
      "Nano thinner sample",
      {
        products: {
          "Nano thinner": { state: "matched", productId: "p1", name: "Nano Thinner 5L" },
        },
        existing: {
          complaints: [],
          samples: [{ id: "s1", productName: "Nano Thinner - 5 Liter", state: "dispatched" }],
        },
      },
    ),
  );
  assert.equal(action(a.actions, "sample").state, "duplicate");
});

test("a sample reason the configuration does not hold is dropped and asked", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [{ intent: "sample_required", confidence: 90, evidence: "" }],
        sample: {
          product: "PU",
          quantityCans: 1,
          application: "doors",
          reasonCode: "invented_reason",
        },
      }),
      "PU sample for doors",
      { products: { PU: { state: "matched", productId: "p3", name: "PU 1L" } } },
    ),
  );
  const s = action(a.actions, "sample");
  assert.equal(s.reasonCode, null);
  assert.equal(s.state, "confirm");
});

/* ------------------------------------------------------------------- leads */

test("a requirement is proposed for a lead and never for a customer", () => {
  const r = reading({
    intents: [{ intent: "requirement_captured", confidence: 85, evidence: "" }],
    requirement: { what: "Thinner for spray booth", monthlyLitres: 200, cans: null },
  });
  const lead = decideVisitActions(
    input(r, "200 litre thinner mahina", {
      customer: { isLead: true, decisionDue: false },
    }),
  );
  assert.equal(action(lead.actions, "requirement").monthlyLitres, 200);
  const customer = decideVisitActions(input(r, "200 litre thinner mahina"));
  assert.equal(action(customer.actions, "requirement"), undefined);
});

test("the Suspect verdict is offered only where the cap demands it, and always as a question", () => {
  const r = reading({
    intents: [{ intent: "not_interested", confidence: 85, evidence: "" }],
    leadVerdict: "not_prospect",
  });
  const due = decideVisitActions(
    input(r, "Interested nahi", { customer: { isLead: true, decisionDue: true } }),
  );
  const d = action(due.actions, "lead_decision");
  assert.equal(d.decision, "lost");
  assert.equal(d.state, "confirm", "the lead never moves on the model's word");

  const notDue = decideVisitActions(
    input(r, "Interested nahi", { customer: { isLead: true, decisionDue: false } }),
  );
  assert.equal(action(notDue.actions, "lead_decision"), undefined);
});

/* --------------------------------------------------------------- come back */

test("no day said leaves the screen's own buying-cycle suggestion alone", () => {
  const a = decideVisitActions(
    input(
      reading({
        intents: [{ intent: "relationship", confidence: 80, evidence: "" }],
      }),
      "Chai pi, sab theek",
    ),
  );
  assert.equal(a.comeBack, null);
  assert.equal(a.outcome?.key, "visited");
});

test("no model at all proposes nothing and says so", () => {
  const a = decideVisitActions(input(null, "order diya 10 nano"));
  assert.equal(a.outcome, null);
  assert.equal(a.actions.length, 0);
  assert.equal(a.readByModel, false);
  assert.ok(a.notes.length > 0);
});

/* ------------------------------------------------- the handset's own words */

const handset = (path: string) =>
  readFileSync(join(process.cwd(), "mbos-app", path), "utf8");

test("the complaint categories are the handset sheet's own chips", () => {
  const src = handset("src/data/fixtures.ts");
  const block = src.slice(src.indexOf("export const COMPLAINT_CATEGORIES"));
  const list = [...block.slice(0, block.indexOf("] as const")).matchAll(/'([^']+)'/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(list, [...HANDSET_COMPLAINT_CATEGORIES]);
});

test("the outcomes are the handset's seven chips", () => {
  const src = handset("src/data/fixtures.ts");
  const block = src.slice(src.indexOf("export const OUTCOMES"));
  const keys = [
    ...block.slice(0, block.indexOf("];")).matchAll(/k: '([^']+)'/g),
  ].map((m) => m[1]);
  assert.deepEqual(keys, [...VISIT_OUTCOMES]);
});

test("the payment modes are the handset payment screen's chips", () => {
  const src = handset("app/pay.tsx");
  const block = src.slice(src.indexOf("const MODES"));
  const labels = [
    ...block.slice(0, block.indexOf("];")).matchAll(/label: '([^']+)'/g),
  ].map((m) => m[1]);
  assert.deepEqual(labels, [...HANDSET_PAY_MODES]);
});
