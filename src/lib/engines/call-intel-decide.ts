import type { WorkingDayConfig } from "@/lib/business-date";
import {
  CALL_INTENT_LABEL,
  INTENT_CALL_REASON,
  INTENT_OUTCOME,
  INTENT_PRECEDENCE,
  type CallIntent,
  type DateSource,
  type SuggestionState,
} from "@/lib/call-intel-labels";
import type { CallReading, DateCueReading } from "@/lib/call-intel-schema";
import {
  NEVER_CALL_AGAIN,
  NO_ANSWER_REASONS,
  NOT_INTERESTED_REASONS,
} from "@/lib/call-outcomes";
import { money } from "@/lib/format";
import type { Prediction } from "./call-intel-classifier";
import {
  crossCheckPhrase,
  dayLabel,
  resolveDateCue,
  workingDaysAhead,
  type DateCue,
  type ResolvedDate,
} from "./call-intel-dates";
import {
  parseAmounts,
  readSignals,
  type RuleSignals,
} from "./call-intel-signals";

/* ---------------------------------------------------------------------------
 * THREE READERS, ONE PROPOSAL, AND THE CLIENT'S RULES IN BETWEEN.
 *
 *   The LANGUAGE MODEL reads the call and extracts everything — intents,
 *   products, amounts, the words each date came from.
 *   The RULES (`call-intel-signals`) look for the few things where a miss is
 *   expensive: do-not-call, no-answer, "maybe", money.
 *   The CLASSIFIER (`call-intel-classifier`), trained on our own logged calls,
 *   votes on which outcome it was.
 *
 * This file turns their answers into what the telecaller sees: one PRIMARY
 * suggestion that fills the call form, EXTRAS that open their own doors
 * (a second reminder, a sample request, a complaint alongside an order), and
 * a summary with the feedback worth a manager's eye.
 *
 * THE RULES IT ENFORCES are the client's, and each is a line below:
 *
 *   - "May order next week" is an OPPORTUNITY, never an order. An order needs
 *     the model to say it was confirmed AND no "maybe" in the words.
 *   - A date is always a real date, worked out here — and where the model's
 *     reading of the words and this file's disagree, both are offered.
 *   - If not sure, ASK. A suggestion below the confidence floor, or where the
 *     classifier confidently disagrees, is drawn as a question with the
 *     candidates as buttons. Fields nobody said are left empty, never filled
 *     with a default.
 *   - Do-not-call is shown whenever EITHER reader hears it, and is never
 *     applied by the assistant — the option that writes it is always a
 *     deliberate click.
 *   - No duplicates: open reminders, complaints, opportunities and samples
 *     are checked, and a match says what already exists instead of offering
 *     to create a second.
 *
 * PURE. Everything it needs — the reading, the classifier's ranking, the
 * existing records, today — is an argument.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------ types */

export type DatedField = {
  date: string | null;
  source: DateSource | null;
  /** How it was worked out, one sentence. */
  explanation: string | null;
  /** Other days the telecaller can pick with one tap. */
  choices: Array<{ date: string; label: string }>;
};

export type ProductMatch =
  | { state: "matched"; productId: string; name: string }
  | { state: "ambiguous"; options: Array<{ productId: string; name: string }> }
  | { state: "none" };

export type ExistingRecords = {
  reminders: Array<{ id: string; dueDate: string; note: string; type: string }>;
  complaints: Array<{
    id: string;
    category: string;
    description: string;
    createdAt: string;
  }>;
  opportunities: Array<{
    id: string;
    product: string;
    createdAt: string;
    expectedOrderDate: string | null;
  }>;
  samples: Array<{
    id: string;
    productName: string;
    state: string;
    requestedAt: string;
  }>;
};

export type Duplicate = {
  kind: "reminder" | "complaint" | "opportunity" | "sample";
  id: string;
  /** "Reminder for Tue 30 Sep: ask for the payment". */
  label: string;
};

/**
 * What the call form receives. Every key is optional: the form fills only
 * what is present, and only where the telecaller has not typed something
 * already — the assistant proposes, it never overwrites.
 */
export type FormFill = {
  outcome: string;
  /** Inbound only: why they rang, where the intent says so plainly. */
  callReason?: string;
  outcomeDetail: Record<string, string>;
  followUpDate?: string;
  noOrderNextCallDate?: string;
  payDate?: string;
  /** Shown beside the date and carried into the note; not a form column. */
  payAmountRupees?: number;
  orderLines?: Array<{
    productId: string;
    name: string;
    quantity: number | null;
  }>;
  complaint?: {
    category: string | null;
    description: string | null;
    requestCn: boolean;
  };
  opportunity?: {
    product: string;
    quantity: string | null;
    valueRupees: number | null;
    date: string | null;
  };
};

export type Suggestion = {
  key: string;
  intent: CallIntent;
  state: SuggestionState;
  title: string;
  /** One line: why the assistant thinks this. */
  why: string;
  /** What the telecaller has to answer before this is right. */
  questions: string[];
  duplicateOf: Duplicate | null;
  date: DatedField | null;
  /** For the primary: fills the call form. For extras: the door's defaults. */
  fill: FormFill | null;
  /** Extras only: which door opens. */
  door: "form" | "reminder" | "sample" | "complaint" | "reschedule" | null;
  /** Extras that open the sample door. */
  sample?: {
    product: ProductMatch | null;
    productSaid: string | null;
    quantityCans: number | null;
    application: string | null;
  };
  /** Extras that write a reminder. */
  reminder?: { dueDate: string | null; note: string };
};

export type CallAnalysis = {
  summary: string;
  /** Who rang whom, where the words said so. Null leaves the form to ask. */
  direction: "outbound_call" | "inbound_call" | null;
  feedback: Array<{
    text: string;
    tone: "positive" | "negative" | "neutral";
    about: string;
  }>;
  doNotCall: {
    quote: string | null;
    heardBy: "model" | "rules" | "both";
    alreadyMarked: boolean;
  } | null;
  primary: Suggestion | null;
  /** Where the primary is a question, the outcomes to choose between. */
  alternatives: Array<{
    outcome: string;
    intent: CallIntent;
    label: string;
    why: string;
    /** What picking this one fills — built exactly as the primary would be. */
    suggestion: Suggestion;
  }>;
  extras: Suggestion[];
  /** Things none of the readers could tell. */
  unclear: string[];
  readers: {
    model: boolean;
    classifier: Prediction | null;
    /** Null where one of the two did not vote. */
    agreed: boolean | null;
  };
};

export type DecideInput = {
  reading: CallReading | null;
  /** Transcript and English together — what the rules read. */
  text: string;
  classifier: Prediction[] | null;
  today: string;
  working: WorkingDayConfig;
  existing: ExistingRecords;
  /** Keyed by the product exactly as the reading named it. */
  products: Record<string, ProductMatch>;
  customer: { doNotContact: boolean };
  config: {
    /** 0-100. Below this a suggestion asks rather than fills. */
    confirmBelow: number;
    /** 0-1. The classifier overrules only at or above this. */
    classifierVetoAt: number;
    noAnswerRetryWorkingDays: number;
    /** A reminder due within this many days of a new one is the same one. */
    duplicateWindowDays: number;
  };
};

/* --------------------------------------------------------------- helpers */

function toCue(c: DateCueReading): DateCue {
  switch (c.kind) {
    case "in_days":
    case "in_weeks":
    case "in_months":
      return c.n === null ? { kind: "unclear" } : { kind: c.kind, n: c.n };
    case "weekday":
      return c.weekday === null
        ? { kind: "unclear" }
        : { kind: "weekday", weekday: c.weekday, which: c.which ?? "this" };
    case "day_of_month":
      return c.day === null
        ? { kind: "unclear" }
        : { kind: "day_of_month", day: c.day, month: c.month };
    case "absolute":
      return c.date ? { kind: "absolute", date: c.date } : { kind: "unclear" };
    default:
      return { kind: c.kind };
  }
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 86_400_000);
}

function ymd(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m - 1, d];
}

/**
 * A spoken date, resolved and cross-checked.
 *
 * The model's cue is resolved; the rules read the same quoted phrase; where
 * they land on different days, the field is left EMPTY and both are offered.
 * A date in the past is refused the same way — the customer did not promise
 * to pay last Tuesday, so something was misheard.
 */
function datedFrom(
  cue: DateCueReading | null | undefined,
  input: DecideInput,
  questions: string[],
  askWhenMissing: string | null,
): DatedField | null {
  if (!cue) {
    if (askWhenMissing) questions.push(askWhenMissing);
    return askWhenMissing
      ? {
          date: null,
          source: null,
          explanation: null,
          choices: defaultChoices(input),
        }
      : null;
  }
  const resolved: ResolvedDate = resolveDateCue(
    toCue(cue),
    input.today,
    input.working,
  );
  const rule = cue.phrase
    ? crossCheckPhrase(cue.phrase, input.today, input.working)
    : null;

  const choices: DatedField["choices"] = [];
  const offer = (date: string | null) => {
    if (date && date >= input.today && !choices.some((c) => c.date === date)) {
      choices.push({ date, label: dayLabel(date) });
    }
  };

  if (!resolved.date) {
    offer(rule);
    questions.push(`"${cue.phrase}" — which day is that?`);
    return {
      date: null,
      source: null,
      explanation: resolved.explanation,
      choices: choices.length ? choices : defaultChoices(input),
    };
  }
  if (resolved.past) {
    questions.push(
      `"${cue.phrase}" reads as ${dayLabel(resolved.date)}, which has already gone. Which day did they mean?`,
    );
    return {
      date: null,
      source: null,
      explanation: resolved.explanation,
      choices: defaultChoices(input),
    };
  }
  if (resolved.alternative) {
    offer(resolved.date);
    offer(resolved.alternative);
    questions.push(resolved.explanation);
    return {
      date: null,
      source: null,
      explanation: resolved.explanation,
      choices,
    };
  }
  if (rule && rule !== resolved.date) {
    offer(resolved.date);
    offer(rule);
    questions.push(
      `"${cue.phrase}" could be ${dayLabel(resolved.date)} or ${dayLabel(rule)} — which one?`,
    );
    return {
      date: null,
      source: null,
      explanation: resolved.explanation,
      choices,
    };
  }
  return {
    date: resolved.date,
    source: "said",
    explanation: resolved.explanation,
    choices: [],
  };
}

/** One-tap suggestions where nobody named a day. Offered, never filled. */
function defaultChoices(input: DecideInput): DatedField["choices"] {
  const out: DatedField["choices"] = [];
  for (const n of [1, 3, 7, 15]) {
    const raw = calendarDaysAhead(input.today, n, input.working);
    if (!out.some((c) => c.date === raw)) {
      out.push({
        date: raw,
        label: `${dayLabel(raw)} · in ${n} day${n === 1 ? "" : "s"}`,
      });
    }
  }
  return out;
}

/** `n` calendar days on, moved to a working day. */
function calendarDaysAhead(
  today: string,
  calendarDays: number,
  working: WorkingDayConfig,
): string {
  const r = resolveDateCue(
    { kind: "in_days", n: calendarDays },
    today,
    working,
  );
  return r.date ?? today;
}

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
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

function reminderDuplicate(
  input: DecideInput,
  date: string | null,
  types: string[],
): Duplicate | null {
  const open = input.existing.reminders.filter((r) => types.includes(r.type));
  const hit = date
    ? open.find(
        (r) =>
          Math.abs(dayDiff(r.dueDate, date)) <=
          input.config.duplicateWindowDays,
      )
    : open[0];
  return hit
    ? {
        kind: "reminder",
        id: hit.id,
        label: `Reminder already open for ${dayLabel(hit.dueDate)}: ${hit.note}`,
      }
    : null;
}

/* ---------------------------------------------------------------- decide */

type Candidate = { intent: CallIntent; confidence: number; evidence: string };

export function decideCallActions(input: DecideInput): CallAnalysis {
  const { reading } = input;
  const rules: RuleSignals = readSignals(input.text);
  const top = input.classifier?.[0] ?? null;

  /* ---------------------------------------------------- do not call */
  const dncModel = Boolean(reading?.doNotCall.said);
  const dncRules = rules.doNotCall.found;
  const doNotCall =
    dncModel || dncRules
      ? {
          quote: reading?.doNotCall.quote ?? rules.doNotCall.quote,
          heardBy: (dncModel && dncRules
            ? "both"
            : dncModel
              ? "model"
              : "rules") as "model" | "rules" | "both",
          alreadyMarked: input.customer.doNotContact,
        }
      : null;

  /* ------------------------------------------- what the model heard */
  let candidates: Candidate[] = (reading?.intents ?? [])
    .filter((c) => c.confidence >= 30)
    .map((c) => ({
      intent: c.intent,
      confidence: Math.min(100, Math.max(0, c.confidence)),
      evidence: c.evidence,
    }));

  const unclear = [...(reading?.unclear ?? [])];
  const notes: string[] = [];

  /*
   * THE CLIENT'S OWN EXAMPLE. An order needs the model to say it was
   * confirmed AND nothing in the words saying maybe. "I may order next week"
   * is an opportunity — an order logged on a maybe is stock dispatched to
   * nobody. Where the rules hear a maybe the model did not, it is demoted and
   * the card says why.
   */
  const orderIdx = candidates.findIndex((c) => c.intent === "order_received");
  if (orderIdx >= 0) {
    const commitment = reading?.order.commitment ?? "none";
    const maybe = rules.tentative.found && !rules.firmOrder.found;
    if (commitment !== "confirmed" || maybe) {
      const was = candidates[orderIdx];
      candidates.splice(orderIdx, 1);
      if (!candidates.some((c) => c.intent === "opportunity")) {
        candidates.push({
          intent: "opportunity",
          confidence: was.confidence,
          evidence: was.evidence,
        });
      }
      notes.push(
        maybe && rules.tentative.quote
          ? `Filed as an opportunity, not an order — "${rules.tentative.quote}" is not a confirmed order.`
          : "Filed as an opportunity, not an order — the customer did not confirm one.",
      );
    }
  }

  /* No answer cannot sit beside a conversation; the model hearing both has
     misread a note about a missed call, or the reverse. */
  const spoke = reading?.reached === "spoke";
  if (
    reading?.reached === "no_answer" &&
    !candidates.some((c) => c.intent === "no_answer")
  ) {
    candidates.push({
      intent: "no_answer",
      confidence: 80,
      evidence: "Nobody was reached.",
    });
  }
  if (spoke) candidates = candidates.filter((c) => c.intent !== "no_answer");

  const ordered = [...candidates].sort(
    (a, b) =>
      INTENT_PRECEDENCE.indexOf(a.intent) - INTENT_PRECEDENCE.indexOf(b.intent),
  );

  /* ------------------------------------------------- the primary */
  let primaryCandidate: Candidate | null = ordered[0] ?? null;

  /* No model at all — the classifier alone points at a form, and ASKS. */
  if (!reading && top) {
    const intent = intentForOutcome(top.label);
    if (intent)
      primaryCandidate = {
        intent,
        confidence: Math.round(top.probability * 100),
        evidence: "From how similar calls were logged.",
      };
  }
  /* Rules hear a missed call the model did not report at all. */
  if (!primaryCandidate && rules.noAnswer.found) {
    primaryCandidate = {
      intent: "no_answer",
      confidence: 60,
      evidence: rules.noAnswer.quote ?? "",
    };
  }

  const alternatives: CallAnalysis["alternatives"] = [];
  const addAlternative = (intent: CallIntent, why: string) => {
    const outcome = INTENT_OUTCOME[intent];
    if (alternatives.some((a) => a.outcome === outcome)) return;
    const suggestion = buildPrimary(
      { intent, confidence: 100, evidence: "" },
      input,
      rules,
      [],
    );
    suggestion.why = why;
    alternatives.push({
      outcome,
      intent,
      label: CALL_INTENT_LABEL[intent],
      why,
      suggestion,
    });
  };

  let forcedConfirm = false;
  const primaryQuestions: string[] = [];

  if (primaryCandidate) {
    const outcome = INTENT_OUTCOME[primaryCandidate.intent];
    /* The classifier, confidently of another mind. */
    const classifierIntent = top ? intentForOutcome(top.label) : null;
    if (
      reading &&
      top &&
      classifierIntent &&
      top.probability >= input.config.classifierVetoAt &&
      top.label !== outcome
    ) {
      forcedConfirm = true;
      addAlternative(primaryCandidate.intent, primaryCandidate.evidence);
      addAlternative(
        classifierIntent,
        `Calls worded like this are usually logged as ${CALL_INTENT_LABEL[classifierIntent]}.`,
      );
    }
    /* The rules heard a missed call and the model heard a conversation. */
    if (
      spoke &&
      rules.noAnswer.found &&
      primaryCandidate.intent !== "no_answer" &&
      primaryCandidate.confidence < 85
    ) {
      forcedConfirm = true;
      addAlternative(primaryCandidate.intent, primaryCandidate.evidence);
      addAlternative("no_answer", `The note says "${rules.noAnswer.quote}".`);
    }
    if (!reading) forcedConfirm = true;
    if (primaryCandidate.confidence < input.config.confirmBelow) {
      forcedConfirm = true;
      addAlternative(primaryCandidate.intent, primaryCandidate.evidence);
      for (const c of ordered.slice(1, 3)) addAlternative(c.intent, c.evidence);
    }
  }

  const primary = primaryCandidate
    ? buildPrimary(primaryCandidate, input, rules, primaryQuestions)
    : null;

  if (primary && forcedConfirm) {
    primary.state = "confirm";
    primary.questions.unshift("Is this what happened on the call?");
  }

  /* ------------------------------------------------------- extras */
  const extras: Suggestion[] = [];
  const primaryIntent = primaryCandidate?.intent ?? null;
  const present = new Set(ordered.map((c) => c.intent));

  /* A sample the customer asked for — its own request, on its own door. */
  if (present.has("sample_required") && reading?.sample) {
    extras.push(buildSample(reading, input));
  }
  /* A complaint mentioned on a call filed as something else. */
  if (
    present.has("complaint") &&
    primaryIntent !== "complaint" &&
    reading?.complaint
  ) {
    extras.push(buildComplaintExtra(reading, input));
  }
  /* Money promised on a call filed as something else becomes a reminder. */
  if (
    present.has("payment_promised") &&
    primaryIntent !== "payment_promised" &&
    reading?.payment
  ) {
    extras.push(
      buildReminderExtra(
        "payment_promised",
        reading.payment.when,
        input,
        paymentNote(reading.payment.amountRupees),
      ),
    );
  }
  /* A call-back asked for on a call filed as something else. */
  if (
    present.has("follow_up") &&
    primaryIntent !== "follow_up" &&
    primaryIntent !== "opportunity" &&
    primaryIntent !== "sample_required" &&
    reading?.followUp?.when
  ) {
    extras.push(
      buildReminderExtra(
        "follow_up",
        reading.followUp.when,
        input,
        "Call back — they asked us to",
      ),
    );
  }
  /* No answer: the retry, and the button that makes it a reminder. */
  if (primaryIntent === "no_answer") {
    const due = workingDaysAhead(
      input.today,
      input.config.noAnswerRetryWorkingDays,
      input.working,
    );
    const dup = reminderDuplicate(input, due, [
      "call_back",
      "payment_promise",
      "order_confirmation",
      "send_information",
      "check_stock",
      "other",
    ]);
    extras.push({
      key: "retry",
      intent: "no_answer",
      state: dup ? "duplicate" : "ready",
      title: `Try again ${dayLabel(due)}`,
      why: "Nobody picked up. The Call Log will bring them back on its own; a reminder pins the day.",
      questions: [],
      duplicateOf: dup,
      date: {
        date: due,
        source: "rule",
        explanation: `${input.config.noAnswerRetryWorkingDays} working day${input.config.noAnswerRetryWorkingDays === 1 ? "" : "s"} from today.`,
        choices: [],
      },
      fill: null,
      door: dup ? "reschedule" : "reminder",
      reminder: { dueDate: due, note: "Try again — no answer last time" },
    });
  }

  const feedback = (reading?.feedback ?? []).slice(0, 5);
  if (notes.length && primary)
    primary.why = [primary.why, ...notes].filter(Boolean).join(" ");

  return {
    summary: reading?.summary ?? "",
    direction:
      reading?.direction === "we_called"
        ? "outbound_call"
        : reading?.direction === "they_called"
          ? "inbound_call"
          : null,
    feedback,
    doNotCall,
    primary,
    alternatives,
    extras,
    unclear,
    readers: {
      model: Boolean(reading),
      classifier: top,
      agreed:
        reading && top && primaryCandidate
          ? top.label === INTENT_OUTCOME[primaryCandidate.intent]
          : null,
    },
  };
}

function intentForOutcome(outcome: string): CallIntent | null {
  switch (outcome) {
    case "order_taken":
      return "order_received";
    case "no_order":
    case "no_answer":
    case "payment_promised":
    case "follow_up":
    case "not_interested":
    case "complaint":
    case "casual_talk":
    case "transport_follow_up":
      return outcome;
    default:
      return null;
  }
}

function paymentNote(amount: number | null | undefined): string {
  return amount
    ? `Payment promised: ${money(amount * 100)}`
    : "Payment promised";
}

/* ------------------------------------------------------ primary builders */

function buildPrimary(
  c: Candidate,
  input: DecideInput,
  rules: RuleSignals,
  questions: string[],
): Suggestion {
  const r = input.reading;
  const outcome = INTENT_OUTCOME[c.intent];
  const base: Suggestion = {
    key: "primary",
    intent: c.intent,
    state: "ready",
    title: CALL_INTENT_LABEL[c.intent],
    why: c.evidence ? `"${c.evidence}"` : "",
    questions,
    duplicateOf: null,
    date: null,
    fill: {
      outcome,
      outcomeDetail: {},
      ...(INTENT_CALL_REASON[c.intent]
        ? { callReason: INTENT_CALL_REASON[c.intent] }
        : {}),
    },
    door: "form",
  };
  const fill = base.fill!;

  switch (c.intent) {
    case "order_received": {
      const lines = r?.order.lines ?? [];
      if (!lines.length) questions.push("Which products, and how many?");
      fill.orderLines = [];
      for (const l of lines) {
        const m = input.products[l.product];
        if (m?.state === "matched") {
          fill.orderLines.push({
            productId: m.productId,
            name: m.name,
            quantity:
              l.unit === "cans" || l.unit === "unknown" ? l.quantity : null,
          });
          if (l.quantity === null)
            questions.push(`How many cans of ${m.name}?`);
          else if (l.unit !== "cans" && l.unit !== "unknown") {
            questions.push(
              `They said ${l.quantity} ${l.unit} of ${m.name} — how many cans is that?`,
            );
          }
        } else if (m?.state === "ambiguous") {
          questions.push(
            `"${l.product}" — which one: ${m.options.map((o) => o.name).join(", ")}?`,
          );
        } else {
          questions.push(
            `"${l.product}" is not in the catalogue under that name — search for it.`,
          );
        }
      }
      break;
    }

    case "complaint": {
      const k = r?.complaint;
      fill.complaint = {
        category: k?.category ?? null,
        description: k?.description ?? null,
        requestCn: Boolean(k?.creditNoteAsked),
      };
      if (k?.requiredAction)
        fill.outcomeDetail.requiredAction = k.requiredAction;
      if (!k?.category) questions.push("What kind of complaint is it?");
      if (!k?.requiredAction)
        questions.push("What are they asking us to do about it?");
      const open = k?.category
        ? input.existing.complaints.find((x) => x.category === k.category)
        : null;
      if (open) {
        base.state = "duplicate";
        base.duplicateOf = {
          kind: "complaint",
          id: open.id,
          label: `An open complaint of this kind from ${dayLabel(open.createdAt.slice(0, 10))}: ${open.description}. Saving adds this call to it rather than raising a second.`,
        };
      }
      break;
    }

    case "not_interested": {
      const n = r?.notInterested;
      if (n?.reason) fill.outcomeDetail.whyNotInterested = n.reason;
      else questions.push("Why are they not interested?");
      if (n?.competitor) fill.outcomeDetail.competitorName = n.competitor;
      /*
       * "They asked us not to call again" writes do-not-contact, which
       * outranks everything in the queue. The assistant never picks it: it is
       * offered on the do-not-call banner as a deliberate click.
       */
      if (n?.futureOpportunity && n.futureOpportunity !== NEVER_CALL_AGAIN) {
        fill.outcomeDetail.futureOpportunity = n.futureOpportunity;
      } else {
        questions.push(
          "Is there a later — or did they ask not to be called again?",
        );
      }
      if (n?.futureOpportunity === "possible_later") {
        base.date = datedFrom(
          n.when,
          input,
          questions,
          "When should we try them again?",
        );
        if (base.date?.date) fill.outcomeDetail.recallDate = base.date.date;
      }
      if (
        n?.reason &&
        !NOT_INTERESTED_REASONS.some((x) => x.code === n.reason)
      ) {
        questions.push("Why are they not interested?");
      }
      break;
    }

    case "no_order": {
      const n = r?.noOrder;
      if (n?.reason) fill.outcomeDetail.whyNoOrder = n.reason;
      else questions.push("Why no order today?");
      base.date = datedFrom(
        n?.when,
        input,
        questions,
        "Did they give a day to call back? Pick one, or tick that they would not say.",
      );
      if (base.date?.date) fill.noOrderNextCallDate = base.date.date;
      if (base.date?.date) {
        const dup = reminderDuplicate(input, base.date.date, ["call_back"]);
        if (dup) {
          base.duplicateOf = dup;
          questions.push(
            "A call-back is already open for about then — saving adds another.",
          );
        }
      }
      break;
    }

    case "payment_promised": {
      const p = r?.payment;
      base.date = datedFrom(
        p?.when,
        input,
        questions,
        "Which day did they promise to pay?",
      );
      if (base.date?.date) fill.payDate = base.date.date;
      const heard = parseAmounts(input.text);
      if (p?.amountRupees) {
        fill.payAmountRupees = p.amountRupees;
        /* Money is where a model is wrong by a zero. The rules read the
           numbers themselves, and a mismatch is asked, never settled. */
        if (heard.length && !heard.includes(Math.round(p.amountRupees))) {
          questions.push(
            `We read ${money(p.amountRupees * 100)}, but the words also say ${heard.map((a) => money(a * 100)).join(", ")}. Which is it?`,
          );
        }
      } else if (heard.length === 1) {
        fill.payAmountRupees = heard[0];
      } else {
        questions.push("How much did they promise?");
      }
      if (fill.payAmountRupees)
        fill.outcomeDetail.promisedAmount = String(
          Math.round(fill.payAmountRupees),
        );
      const dup = reminderDuplicate(input, base.date?.date ?? null, [
        "payment_promise",
      ]);
      if (dup) {
        base.state = "duplicate";
        base.duplicateOf = dup;
      }
      break;
    }

    case "opportunity":
    case "sample_required":
    case "follow_up": {
      const f = r?.followUp;
      const o = r?.opportunity;
      fill.outcomeDetail.followUpReason =
        f?.reason ??
        (c.intent === "sample_required"
          ? "waiting_sample"
          : c.intent === "opportunity"
            ? "waiting_requirement"
            : "customer_asked_later");
      const cue = f?.when ?? o?.when ?? null;
      base.date = datedFrom(
        cue,
        input,
        questions,
        "When should we call them back?",
      );
      if (base.date?.date) {
        fill.followUpDate = base.date.date;
        const dup = reminderDuplicate(input, base.date.date, ["call_back"]);
        if (dup) {
          base.duplicateOf = dup;
          questions.push(
            "A call-back is already open for about then — saving adds another.",
          );
        }
      }
      if (c.intent === "opportunity" && o) {
        const said = o.product ?? "";
        const match = said ? input.products[said] : undefined;
        const product = match?.state === "matched" ? match.name : said;
        const oppDate = o.when
          ? resolveDateCue(toCue(o.when), input.today, input.working)
          : null;
        fill.opportunity = {
          product,
          quantity: o.quantity,
          valueRupees: o.valueRupees,
          date:
            oppDate?.date && !oppDate.past && !oppDate.alternative
              ? oppDate.date
              : null,
        };
        if (!product) questions.push("What might they buy?");
        const dupOpp = product
          ? input.existing.opportunities.find((x) =>
              sameProduct(x.product, product),
            )
          : null;
        if (dupOpp) {
          base.state = "duplicate";
          base.duplicateOf = {
            kind: "opportunity",
            id: dupOpp.id,
            label: `An opportunity for ${dupOpp.product} was recorded ${dayLabel(dupOpp.createdAt.slice(0, 10))}. Saving without it keeps one record.`,
          };
        }
      }
      break;
    }

    case "no_answer": {
      const why = r?.noAnswerReason ?? ruleNoAnswerReason(rules.noAnswer.quote);
      if (why) fill.outcomeDetail.whyNoAnswer = why;
      else
        questions.push(
          "Which kind of no answer — ringing, busy, switched off?",
        );
      break;
    }

    case "casual_talk": {
      if (r?.casual?.purpose) fill.outcomeDetail.purpose = r.casual.purpose;
      const worth = (r?.feedback ?? []).map((f) => f.text).join(" ");
      if (worth) fill.outcomeDetail.customerFeedback = worth.slice(0, 500);
      break;
    }
  }

  if (questions.length && base.state === "ready") base.state = "confirm";
  return base;
}

/** The kind of silence, from the words, where the model did not say. */
export function ruleNoAnswerReason(quote: string | null): string | null {
  if (!quote) return null;
  const q = quote.toLowerCase();
  const code = /switch/.test(q)
    ? "switched_off"
    : /busy/.test(q)
      ? "busy"
      : /network|coverage|reach/.test(q)
        ? "out_of_network"
        : /reject|cut/.test(q)
          ? "call_rejected"
          : /disconnect/.test(q)
            ? "call_disconnected"
            : "no_response";
  return NO_ANSWER_REASONS.some((r) => r.code === code) ? code : null;
}

/* -------------------------------------------------------- extra builders */

function buildSample(reading: CallReading, input: DecideInput): Suggestion {
  const s = reading.sample!;
  const questions: string[] = [];
  const said = s.product ?? null;
  const match = said
    ? (input.products[said] ?? { state: "none" as const })
    : null;
  if (!said) questions.push("Which product do they want to try?");
  else if (match?.state === "ambiguous")
    questions.push(
      `"${said}" — which one: ${match.options.map((o) => o.name).join(", ")}?`,
    );
  else if (match?.state === "none")
    questions.push(
      `"${said}" is not in the catalogue under that name — pick it.`,
    );
  if (!s.application) questions.push("What will they use it on?");
  if (!s.quantityCans) questions.push("How many cans?");

  const name = match?.state === "matched" ? match.name : said;
  const open = name
    ? input.existing.samples.find((x) => sameProduct(x.productName, name))
    : input.existing.samples[0];
  return {
    key: "sample",
    intent: "sample_required",
    state: open ? "duplicate" : questions.length ? "confirm" : "ready",
    title: name ? `Sample: ${name}` : "Sample requested",
    why: "They asked to try it.",
    questions,
    duplicateOf: open
      ? {
          kind: "sample",
          id: open.id,
          label: `A sample of ${open.productName} is already in progress (${open.state.replace(/_/g, " ")}).`,
        }
      : null,
    date: null,
    fill: null,
    door: "sample",
    sample: {
      product: match,
      productSaid: said,
      quantityCans: s.quantityCans,
      application: s.application,
    },
  };
}

function buildComplaintExtra(
  reading: CallReading,
  input: DecideInput,
): Suggestion {
  const k = reading.complaint!;
  const open = k.category
    ? input.existing.complaints.find((x) => x.category === k.category)
    : null;
  const questions: string[] = [];
  if (!k.category) questions.push("What kind of complaint is it?");
  return {
    key: "complaint",
    intent: "complaint",
    state: open ? "duplicate" : questions.length ? "confirm" : "ready",
    title: "Complaint",
    why: k.description ?? "They raised a problem.",
    questions,
    duplicateOf: open
      ? {
          kind: "complaint",
          id: open.id,
          label: `Already open since ${dayLabel(open.createdAt.slice(0, 10))}: ${open.description}`,
        }
      : null,
    date: null,
    fill: {
      outcome: "complaint",
      outcomeDetail: k.requiredAction
        ? { requiredAction: k.requiredAction }
        : {},
      complaint: {
        category: k.category,
        description: k.description,
        requestCn: k.creditNoteAsked,
      },
    },
    door: "complaint",
  };
}

function buildReminderExtra(
  intent: CallIntent,
  cue: DateCueReading | null,
  input: DecideInput,
  note: string,
): Suggestion {
  const questions: string[] = [];
  const date = datedFrom(cue, input, questions, "Which day?");
  const types =
    intent === "payment_promised" ? ["payment_promise"] : ["call_back"];
  const dup = reminderDuplicate(input, date?.date ?? null, types);
  return {
    key: `reminder-${intent}`,
    intent,
    state: dup ? "duplicate" : questions.length ? "confirm" : "ready",
    title: `${CALL_INTENT_LABEL[intent]}${date?.date ? ` — ${dayLabel(date.date)}` : ""}`,
    why: note,
    questions,
    duplicateOf: dup,
    date,
    fill: null,
    door: dup ? "reschedule" : "reminder",
    reminder: { dueDate: date?.date ?? null, note },
  };
}
