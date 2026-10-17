import type { WorkingDayConfig } from "@/lib/business-date";
import {
  datedFrom,
  type DatedField,
  type ProductMatch,
} from "@/lib/engines/call-intel-decide";
import { parseAmounts, readSignals } from "@/lib/engines/call-intel-signals";
import {
  INTENT_VISIT_OUTCOME,
  VISIT_INTENT_LABEL,
  VISIT_INTENT_PRECEDENCE,
  VISIT_OUTCOME_LABEL,
  type VisitIntent,
  type VisitOutcome,
} from "@/lib/visit-intel-labels";
import type { VisitReading } from "@/lib/visit-intel-schema";

/* ---------------------------------------------------------------------------
 * WHAT A VISIT SHOULD BE SAVED AS, AND WHAT IT SHOULD LEAVE BEHIND.
 *
 * The salesman says what happened in the shop; the model reads it into
 * `visitReadingSchema`; this decides what the visit screen is offered. It is
 * the call assistant's engine applied to a different conversation, and the
 * client's rules carry across word for word:
 *
 *   - It PROPOSES and never writes. Every action here is a door onto the
 *     handset's own form — the order screen with the cart filled, the payment
 *     screen with the amount typed, the complaint sheet with the category
 *     picked — and the ordinary Save is the only thing that records anything.
 *   - "Will order next week" is a maybe, never an order. An order needs the
 *     model to say confirmed AND no "maybe" in the words. An order punched on a
 *     maybe is stock loaded onto a lorry for nobody.
 *   - Unsure means ASK. Below the confidence floor the outcome is a question
 *     with the candidates as chips; a date that could be two days is left
 *     empty with both offered; an amount the model and the words disagree on
 *     is named twice and picked by a person.
 *   - Nothing twice. An open complaint in the same category, or an open sample
 *     of the same product, is NAMED rather than proposed again.
 *
 * WHAT IS NEW TO A VISIT, and is the reason this is not the call engine:
 *
 *   - Money can be HANDED OVER. "Collected 20 hazar cash" is a receipt to
 *     write now; "will pay on the 5th" is a date to come back. They are two
 *     different actions with two different doors, and filing the second as
 *     the first would put cash in a salesman's pocket that is not there.
 *   - Nobody may be there. A shut shutter or an owner at lunch is an outcome
 *     of its own, and nothing a staff member said about an order stands in
 *     for the owner saying it.
 *   - A LEAD is asked what it needs. The requirement and, where the Suspect
 *     cap demands one, the Prospect-or-not verdict are proposed from the words
 *     — the verdict as a suggestion he still has to tap, never as a move,
 *     because §28's whole point is that no lead climbs a rung on its own.
 *
 * PURE. The reading, the words, today and the existing records are arguments.
 * ------------------------------------------------------------------------- */

export type VisitSuggestionState = "ready" | "confirm" | "duplicate";

export type VisitOrderLine = {
  /** The product as it was said. */
  said: string;
  product: ProductMatch;
  /** Cans, where the words gave cans (or a drum, which is one). */
  quantityCans: number | null;
  /** "20 litres" — said in a unit the cart does not count in. */
  saidAs: string | null;
};

export type VisitAction =
  | {
      kind: "order";
      state: VisitSuggestionState;
      title: string;
      why: string;
      lines: VisitOrderLine[];
      questions: string[];
    }
  | {
      kind: "payment";
      state: VisitSuggestionState;
      title: string;
      why: string;
      amountRupees: number | null;
      /** One of the handset's four mode chips, by label. */
      mode: string | null;
      questions: string[];
    }
  | {
      kind: "promise";
      state: VisitSuggestionState;
      title: string;
      why: string;
      amountRupees: number | null;
      date: DatedField | null;
      questions: string[];
    }
  | {
      kind: "complaint";
      state: VisitSuggestionState;
      title: string;
      why: string;
      category: string | null;
      description: string | null;
      priority: "medium" | "high";
      duplicateOf: string | null;
      questions: string[];
    }
  | {
      kind: "sample";
      state: VisitSuggestionState;
      title: string;
      why: string;
      productSaid: string | null;
      product: ProductMatch | null;
      cans: number | null;
      application: string | null;
      reasonCode: string | null;
      duplicateOf: string | null;
      questions: string[];
    }
  | {
      kind: "opportunity";
      state: VisitSuggestionState;
      title: string;
      why: string;
      product: string | null;
      date: DatedField | null;
      questions: string[];
    }
  | {
      kind: "requirement";
      state: VisitSuggestionState;
      title: string;
      why: string;
      what: string | null;
      monthlyLitres: number | null;
      cans: number | null;
      questions: string[];
    }
  | {
      kind: "lead_decision";
      state: VisitSuggestionState;
      title: string;
      why: string;
      /** The handset's own decision values. Never applied without a tap. */
      decision: "qualified" | "lost" | null;
      questions: string[];
    };

export type VisitAnalysis = {
  summary: string;
  outcome: {
    key: VisitOutcome;
    label: string;
    state: "ready" | "confirm";
    why: string;
  } | null;
  /** Where the outcome is a question: the chips to choose between. */
  outcomeChoices: Array<{ key: VisitOutcome; label: string; why: string }>;
  /** When to come back, where the words named a day. Null otherwise — the
      screen keeps its own suggestion from the customer's buying cycle. */
  comeBack: DatedField | null;
  actions: VisitAction[];
  competitor: string | null;
  feedback: VisitReading["feedback"];
  /** Things the salesman has to answer; none of the readers could tell. */
  questions: string[];
  /** Why the proposal says what it says, where that is not obvious. */
  notes: string[];
  /** False where no language model answered and only the rules read it. */
  readByModel: boolean;
};

export type VisitExisting = {
  /** Open complaints, category already in the handset's words. */
  complaints: Array<{ id: string; category: string; description: string }>;
  /** Open samples by product name. */
  samples: Array<{ id: string; productName: string; state: string }>;
};

export type VisitDecideInput = {
  reading: VisitReading | null;
  text: string;
  today: string;
  working: WorkingDayConfig;
  existing: VisitExisting;
  /** Keyed by the product exactly as the reading named it. */
  products: Record<string, ProductMatch>;
  customer: {
    isLead: boolean;
    /** The Suspect cap is demanding a Prospect-or-not answer on this visit. */
    decisionDue: boolean;
  };
  /** The configured sample reasons, by code — anything else is dropped. */
  sampleReasonCodes: string[];
  config: {
    /** 0-100. Below this the outcome asks rather than fills. */
    confirmBelow: number;
  };
};

type Candidate = { intent: VisitIntent; confidence: number; evidence: string };

/** How close to the strongest intent another must be to outrank it by kind. */
const PRECEDENCE_BAND = 15;
/** An intent below this was a passing remark, not something that happened. */
const NOISE_FLOOR = 30;

const rupees = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "Nano thinner" ~ "Nano Thinner - 5 Liter (Loose)": either contains the other. */
function sameProduct(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
}

/**
 * The amount, checked against the words.
 *
 * Indian number words are where a model is confidently wrong by a zero, so
 * `parseAmounts` reads the same words. Agreement fills; disagreement ASKS and
 * names both; a model that heard no amount where the words hold exactly one
 * gets the words' figure, still as a question.
 */
function checkedAmount(
  said: number | null,
  text: string,
  questions: string[],
): { amount: number | null; sure: boolean } {
  const heard = parseAmounts(text);
  if (said != null && said > 0) {
    if (!heard.length || heard.includes(Math.round(said))) {
      return { amount: Math.round(said), sure: true };
    }
    const other = heard.find((h) => h !== Math.round(said));
    questions.push(
      other != null
        ? `Was it ${rupees(said)} or ${rupees(other)}?`
        : `Check the amount — ${rupees(said)}.`,
    );
    return { amount: Math.round(said), sure: false };
  }
  if (heard.length === 1) {
    questions.push(`Read ${rupees(heard[0])} from the words — is that right?`);
    return { amount: heard[0], sure: false };
  }
  return { amount: null, sure: false };
}

function orderLines(
  reading: VisitReading,
  products: Record<string, ProductMatch>,
  questions: string[],
): VisitOrderLine[] {
  return reading.order.lines
    .filter((l) => l.product.trim())
    .map((l) => {
      const product = products[l.product] ?? { state: "none" as const };
      if (product.state === "none") {
        questions.push(`"${l.product}" — which product is that?`);
      } else if (product.state === "ambiguous") {
        questions.push(`Which ${l.product}?`);
      }
      /* A drum is one container, which is what the cart counts; so is a
         number said with no unit at all, the commonest way a quantity is
         spoken ("das nano"). Litres, boxes and kilograms are not cans, and
         converting them here would be a pack size guessed on his behalf. */
      const counts =
        l.unit === "cans" || l.unit === "drums" || l.unit === "unknown";
      let quantityCans: number | null = null;
      let saidAs: string | null = null;
      if (l.quantity != null && l.quantity > 0) {
        if (counts) quantityCans = Math.round(l.quantity);
        else {
          saidAs = `${l.quantity} ${l.unit}`;
          questions.push(
            `${l.product}: ${saidAs} — how many cans is that?`,
          );
        }
      } else {
        questions.push(`How many cans of ${l.product}?`);
      }
      return { said: l.product, product, quantityCans, saidAs };
    });
}

export function decideVisitActions(input: VisitDecideInput): VisitAnalysis {
  const { reading } = input;
  const rules = readSignals(input.text);
  const questions: string[] = [...(reading?.unclear ?? [])];
  const notes: string[] = [];

  let candidates: Candidate[] = (reading?.intents ?? [])
    .filter((c) => c.confidence >= NOISE_FLOOR)
    .map((c) => ({
      intent: c.intent,
      confidence: Math.min(100, Math.max(0, c.confidence)),
      evidence: c.evidence,
    }));

  /* A MAYBE IS NOT AN ORDER. The client's own example, enforced on the visit
     exactly as on the call. */
  const orderIdx = candidates.findIndex((c) => c.intent === "order_taken");
  if (orderIdx >= 0) {
    const commitment = reading?.order.commitment ?? "none";
    const maybe = rules.tentative.found && !rules.firmOrder.found;
    if (commitment !== "confirmed" || maybe) {
      const was = candidates[orderIdx];
      candidates.splice(orderIdx, 1);
      if (!candidates.some((c) => c.intent === "opportunity")) {
        candidates.push({ ...was, intent: "opportunity" });
      }
      notes.push(
        maybe && rules.tentative.quote
          ? `Not an order — "${rules.tentative.quote}" is a maybe. Proposed as a date to come back instead.`
          : "Not an order — the customer did not confirm one. Proposed as a date to come back instead.",
      );
    }
  }

  /* NOBODY THERE CANNOT SIT BESIDE A CONVERSATION. Where the model says
     nobody was met, what anybody "said" was a staff member's guess or a
     misreading, and the outcome is the empty shop. Where it says somebody
     was met, the two "nobody" intents are dropped. */
  const nobody = reading?.met === "nobody" || reading?.shop === "closed";
  if (nobody) {
    const empty: VisitIntent =
      reading?.shop === "closed" ? "shop_closed" : "owner_not_available";
    if (!candidates.some((c) => c.intent === empty)) {
      candidates.push({ intent: empty, confidence: 80, evidence: "" });
    }
    candidates = candidates.filter(
      (c) =>
        c.intent === "shop_closed" ||
        c.intent === "owner_not_available" ||
        c.intent === "payment_collected",
    );
  } else if (reading?.met === "decision_maker" || reading?.met === "staff") {
    candidates = candidates.filter(
      (c) => c.intent !== "shop_closed" && c.intent !== "owner_not_available",
    );
  }

  /* Money handed over needs an amount; with none heard at all it is a promise
     at best, and the card asks. */
  const collected = reading?.payment?.collectedRupees ?? null;

  /* ------------------------------------------------------------- outcome */
  const ordered = [...candidates].sort(
    (a, b) =>
      VISIT_INTENT_PRECEDENCE.indexOf(a.intent) -
      VISIT_INTENT_PRECEDENCE.indexOf(b.intent),
  );
  const strongest = Math.max(0, ...ordered.map((c) => c.confidence));
  const contenders = ordered.filter(
    (c) => c.confidence >= strongest - PRECEDENCE_BAND,
  );
  const primary = contenders[0] ?? null;

  let outcome: VisitAnalysis["outcome"] = null;
  const outcomeChoices: VisitAnalysis["outcomeChoices"] = [];
  if (primary) {
    const key = INTENT_VISIT_OUTCOME[primary.intent];
    /* Two strong intents that file under DIFFERENT chips is the one place the
       ranking is a guess — ask, with both on offer. */
    const rivals = contenders.filter(
      (c) =>
        INTENT_VISIT_OUTCOME[c.intent] !== key &&
        c.confidence >= input.config.confirmBelow,
    );
    const sure =
      primary.confidence >= input.config.confirmBelow && rivals.length === 0;
    outcome = {
      key,
      label: VISIT_OUTCOME_LABEL[key],
      state: sure ? "ready" : "confirm",
      why: primary.evidence
        ? `"${primary.evidence}"`
        : VISIT_INTENT_LABEL[primary.intent],
    };
    if (!sure) {
      for (const c of [primary, ...rivals, ...contenders]) {
        const k = INTENT_VISIT_OUTCOME[c.intent];
        if (outcomeChoices.some((o) => o.key === k)) continue;
        outcomeChoices.push({
          key: k,
          label: VISIT_OUTCOME_LABEL[k],
          why: c.evidence ? `"${c.evidence}"` : VISIT_INTENT_LABEL[c.intent],
        });
      }
      if (outcomeChoices.length === 1 && key !== "visited") {
        outcomeChoices.push({
          key: "visited",
          label: VISIT_OUTCOME_LABEL.visited,
          why: "Nothing was handed over or raised.",
        });
      }
    }
  }

  /* ------------------------------------------------------------- actions */
  const actions: VisitAction[] = [];
  const has = (i: VisitIntent) => candidates.some((c) => c.intent === i);

  if (reading && has("order_taken")) {
    const q: string[] = [];
    const lines = orderLines(reading, input.products, q);
    const ready = lines.filter(
      (l) => l.product.state === "matched" && l.quantityCans != null,
    ).length;
    actions.push({
      kind: "order",
      state: q.length || !lines.length ? "confirm" : "ready",
      title: lines.length
        ? `Order · ${lines.length} line${lines.length === 1 ? "" : "s"}`
        : "Order",
      why:
        ready === lines.length && lines.length
          ? "Every line matched a product — check the quantities in the cart."
          : "Some lines need you to pick the product or the quantity.",
      lines,
      questions: lines.length ? q : ["What did they order?"],
    });
  }

  if (reading && (has("payment_collected") || (collected ?? 0) > 0)) {
    const q: string[] = [];
    const { amount, sure } = checkedAmount(collected, input.text, q);
    const mode = reading.payment?.mode ?? null;
    if (!mode) q.push("Cash, cheque, UPI or a bank transfer?");
    if (amount == null) q.push("How much did they hand over?");
    actions.push({
      kind: "payment",
      state: sure && mode ? "ready" : "confirm",
      title:
        amount != null
          ? `Collect ${rupees(amount)}${mode ? ` · ${mode}` : ""}`
          : "Collect a payment",
      why: "Money handed over on the visit is a receipt to write now.",
      amountRupees: amount,
      mode,
      questions: q,
    });
  }

  if (reading && has("payment_promised")) {
    const q: string[] = [];
    const promised = reading.payment?.promisedRupees ?? null;
    const { amount } =
      promised != null
        ? checkedAmount(promised, input.text, q)
        : { amount: null };
    const date = datedFrom(
      reading.payment?.when,
      input,
      q,
      "When will they pay?",
    );
    actions.push({
      kind: "promise",
      state: date?.date && q.length === 0 ? "ready" : "confirm",
      title: `Payment promised${amount != null ? ` · ${rupees(amount)}` : ""}`,
      why: "Nothing was paid today, so it is a day to come back — not a receipt.",
      amountRupees: amount,
      date,
      questions: q,
    });
  }

  if (reading && (has("complaint") || reading.complaint)) {
    const q: string[] = [];
    const category = reading.complaint?.category ?? null;
    if (!category) q.push("What kind of complaint is it?");
    const description = reading.complaint?.description ?? null;
    if (!description) q.push("What exactly did they say was wrong?");
    const dup = category
      ? input.existing.complaints.find((c) => c.category === category)
      : null;
    actions.push({
      kind: "complaint",
      state: dup ? "duplicate" : q.length ? "confirm" : "ready",
      title: `Complaint${category ? ` · ${category}` : ""}`,
      why: dup
        ? `Already open: ${dup.category} — ${dup.description.slice(0, 80)}`
        : "Logged now, the desk team picks it up today.",
      category,
      description,
      priority: reading.complaint?.urgent ? "high" : "medium",
      duplicateOf: dup?.id ?? null,
      questions: dup ? [] : q,
    });
  }

  if (reading && (has("sample_required") || reading.sample)) {
    const q: string[] = [];
    const said = reading.sample?.product ?? null;
    const product = said ? (input.products[said] ?? { state: "none" }) : null;
    if (!said) q.push("A sample of which product?");
    else if (product?.state === "ambiguous") q.push(`Which ${said}?`);
    else if (product?.state === "none")
      q.push(`"${said}" — which product is that?`);
    const application = reading.sample?.application ?? null;
    if (!application) q.push("What will they try it on?");
    const reasonCode =
      reading.sample?.reasonCode &&
      input.sampleReasonCodes.includes(reading.sample.reasonCode)
        ? reading.sample.reasonCode
        : null;
    if (!reasonCode) q.push("Why do they want a trial?");
    const dup = said
      ? input.existing.samples.find((s) => sameProduct(s.productName, said))
      : null;
    actions.push({
      kind: "sample",
      state: dup ? "duplicate" : q.length ? "confirm" : "ready",
      title: `Sample${said ? ` · ${said}` : ""}`,
      why: dup
        ? `A sample of ${dup.productName} is already ${dup.state.replace(/_/g, " ")}.`
        : "Opens the sample request with what they said filled in.",
      productSaid: said,
      product,
      cans: reading.sample?.quantityCans ?? null,
      application,
      reasonCode,
      duplicateOf: dup?.id ?? null,
      questions: dup ? [] : q,
    });
  }

  if (reading && has("opportunity") && !has("order_taken")) {
    const q: string[] = [];
    const date = datedFrom(reading.opportunity?.when, input, q, null);
    actions.push({
      kind: "opportunity",
      state: q.length ? "confirm" : "ready",
      title: `May order${reading.opportunity?.product ? ` · ${reading.opportunity.product}` : ""}`,
      why: "A maybe is a date to come back, not an order.",
      product: reading.opportunity?.product ?? null,
      date,
      questions: q,
    });
  }

  /* §G — only a lead is asked what it needs. */
  if (reading && input.customer.isLead && reading.requirement) {
    const r = reading.requirement;
    if (r.what || r.monthlyLitres != null || r.cans != null) {
      actions.push({
        kind: "requirement",
        state: r.what ? "ready" : "confirm",
        title: "Requirement",
        why: "Fills the lead's requirement on this visit.",
        what: r.what,
        monthlyLitres:
          r.monthlyLitres != null ? Math.round(r.monthlyLitres) : null,
        cans: r.cans != null ? Math.round(r.cans) : null,
        questions: r.what ? [] : ["What are they looking for?"],
      });
    }
  }

  /* §B — the Suspect verdict, only where the cap is demanding one. A
     suggestion he must still tap; the lead never moves on the model's word. */
  if (reading && input.customer.isLead && input.customer.decisionDue) {
    const verdict = reading.leadVerdict;
    actions.push({
      kind: "lead_decision",
      state: "confirm",
      title:
        verdict === "prospect"
          ? "Sounds like a prospect"
          : verdict === "not_prospect" || has("not_interested")
            ? "Sounds like it is not worth pursuing"
            : "Prospect or not?",
      why: "This visit has to say which way the lead goes. Your call, not the assistant's.",
      decision:
        verdict === "prospect"
          ? "qualified"
          : verdict === "not_prospect" || has("not_interested")
            ? "lost"
            : null,
      questions: [],
    });
  }

  /* ------------------------------------------------------------ come back
   *
   * The day to come back, where the words named one. A promise's day wins
   * over a general "come next week", because it is the day there is a reason
   * to be there. Where nothing was said the screen keeps the day it already
   * offers from the customer's own buying cycle — the assistant does not
   * replace a measured rhythm with a guess.
   */
  const promise = actions.find((a) => a.kind === "promise");
  const maybe = actions.find((a) => a.kind === "opportunity");
  let comeBack: DatedField | null = null;
  if (promise?.kind === "promise" && promise.date?.date) comeBack = promise.date;
  else if (reading?.comeBack) {
    comeBack = datedFrom(reading.comeBack, input, questions, null);
  } else if (maybe?.kind === "opportunity" && maybe.date?.date) {
    comeBack = maybe.date;
  }

  if (!reading) {
    notes.push(
      "No language model answered, so only the rules read this — fill the visit yourself.",
    );
    if (rules.firmOrder.found) {
      notes.push(`The words sound like an order: "${rules.firmOrder.quote}".`);
    }
  }

  return {
    summary: reading?.summary ?? "",
    outcome,
    outcomeChoices,
    comeBack,
    actions,
    competitor: reading?.competitor ?? null,
    feedback: reading?.feedback ?? [],
    questions: [...new Set(questions)],
    notes,
    readByModel: Boolean(reading),
  };
}
