/* ---------------------------------------------------------------------------
 * The calling desk's WORDS — phase names, tones, the sentence that says where a
 * lead stands, and how a due day is drawn.
 *
 * Pure and client-safe, like `lead-labels.ts` beside it: the dashboard is a
 * server component and the record's tabs are client components, and a sentence
 * typed into one of them is the copy that drifts from the other. Nothing here
 * decides a rule — `engines/lead-calling-desk.ts` does — this is what the rule
 * is called on screen.
 * ------------------------------------------------------------------------- */

import type { DeskPhase, LadderKey } from "./engines/lead-calling-desk";
import { MAX_QUALIFICATION_CALLS, nextCallNumber } from "./engines/lead-calling-desk";
import { shortDate, stamp } from "./format";

export type Tone = "neutral" | "brand" | "success" | "warn" | "danger" | "muted";

export const PHASE_LABEL: Record<DeskPhase, string> = {
  call1: "Call 1 pending",
  call2: "Call 2 pending",
  call3: "Call 3 pending",
  ready: "Ready for Prospect",
  exhausted: "Three calls used",
  requested: "Awaiting verification",
  followup: "Manager follow-up",
  returned: "Returned by Manager",
  prospect: "Prospect",
  qualification: "Qualification",
  sample_trial: "Sample / Trial",
  sample_received: "Sample Received",
  sample_review: "Sample Review",
  negotiation: "Negotiation",
  first_order: "1st Order",
  delivery: "Delivery",
  payment: "Payment",
  second_order: "2nd Order",
  customer: "Customer",
  parked: "On hold",
  lost: "Lost",
  beyond: "Further on",
};

export const PHASE_TONE: Record<DeskPhase, Tone> = {
  call1: "neutral",
  call2: "warn",
  call3: "warn",
  ready: "success",
  exhausted: "danger",
  requested: "warn",
  followup: "warn",
  returned: "danger",
  prospect: "brand",
  qualification: "brand",
  sample_trial: "brand",
  sample_received: "brand",
  sample_review: "brand",
  negotiation: "brand",
  first_order: "brand",
  delivery: "brand",
  payment: "brand",
  second_order: "brand",
  customer: "success",
  parked: "muted",
  lost: "danger",
  beyond: "muted",
};

/** The ladder's rung names, exactly as the sales manager's screens draw them. */
export const LADDER_LABEL: Record<LadderKey, string> = {
  suspect: "Suspect",
  prospect: "Prospect",
  qualification: "Qualification",
  sample_trial: "Sample / Trial",
  sample_received: "Sample Received",
  sample_review: "Sample Review",
  negotiation: "Negotiation",
  first_order: "1st Order",
  delivery: "Delivery",
  payment: "Payment",
  second_order: "2nd Order",
  customer: "Customer",
};

/**
 * What the desk sends to a customer without using a call.
 *
 * `code` is the communication action `recordCommunication` already knows where
 * it exists; `whatsapp_followup` has no counterpart there and is written under
 * its own code, which the Communication screen already draws as "unknown"
 * rather than refusing.
 */
export const MESSAGE_KINDS: readonly { code: string; label: string; icon: "doc" | "eye" | "book" | "chat" | "rupee" }[] = [
  { code: "company_profile", label: "Company profile", icon: "doc" },
  { code: "product_image", label: "Product image", icon: "eye" },
  { code: "brochure", label: "Brochure", icon: "book" },
  { code: "video", label: "Video", icon: "chat" },
  { code: "price_list", label: "Price list", icon: "rupee" },
  { code: "whatsapp_followup", label: "WhatsApp follow-up", icon: "chat" },
] as const;

export function messageLabel(code: string): string {
  return MESSAGE_KINDS.find((k) => k.code === code)?.label ?? code;
}

/* ------------------------------------------------------------------ reference */

/**
 * `TC-1042` — the number a lead is quoted by.
 *
 * It is the lead's place in the order leads were raised, counted from 1,000 so
 * it reads as a reference and not a row count. Read off the order rather than
 * stored, because nothing in the schema holds a lead number and a stored copy
 * would need a writer on every path that raises one. `customers.external_code`
 * is the sheet's CUSTOMER code and is not this.
 */
export function deskReference(rank: number): string {
  return `TC-${1000 + Math.max(0, Math.trunc(rank))}`;
}

/* ------------------------------------------------------------------ days */

/** "23 Sep" — the desk's one date shape. A date-only string is read as itself; an instant, in IST. */
export function shortDay(v: string | null | undefined): string {
  if (!v) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return shortDate(v);
  return stamp(v).split(",")[0] ?? "—";
}

/** Whole days from `from` to `to`, both ISO dates. Negative where `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export type DueLabel = { text: string; sub: string | null; tone: "danger" | "warn" | "success" | "muted" | "body" };

/** The right-hand column of a lead row: what is owed, and how late. */
export function dueLabel(phase: DeskPhase, dueDate: string | null, day: string): DueLabel {
  switch (phase) {
    case "ready":
      return { text: "Request now", sub: null, tone: "success" };
    case "requested":
      return { text: "With Manager", sub: null, tone: "warn" };
    case "followup":
      return { text: "Follow-up", sub: null, tone: "warn" };
    case "returned":
      return { text: "Act now", sub: null, tone: "danger" };
    case "exhausted":
      return { text: "Close it", sub: null, tone: "danger" };
    case "lost":
      return { text: "Closed", sub: null, tone: "muted" };
    case "customer":
      return { text: "Customer", sub: null, tone: "success" };
    default:
      break;
  }
  if (!dueDate) return { text: "—", sub: null, tone: "muted" };
  const d = daysBetween(day, dueDate);
  return {
    text: d < 0 ? `${Math.abs(d)}d overdue` : d === 0 ? "Today" : `in ${d}d`,
    sub: dueDate,
    tone: d < 0 ? "danger" : d === 0 ? "warn" : "body",
  };
}

/** The coloured bar down a row's left edge. */
export function rowBar(phase: DeskPhase, dueDate: string | null, day: string): string {
  const working = phase === "call1" || phase === "call2" || phase === "call3";
  if (phase === "ready") return "bg-success";
  if (phase === "lost") return "bg-line-strong";
  if (phase === "returned" || phase === "exhausted") return "bg-danger";
  if (phase === "requested" || phase === "followup") return "bg-warn";
  if (!working) return "bg-brand";
  const d = dueDate ? daysBetween(day, dueDate) : null;
  return d !== null && d < 0 ? "bg-danger" : d === 0 ? "bg-warn" : "bg-line-strong";
}

/* ------------------------------------------------------------------ where a lead stands, in words */

export type StageStatusFacts = {
  phase: DeskPhase;
  qualDone: number;
  qualTotal: number;
  sampleState: string | null;
  trialOutcome: string | null;
  commitment: string | null;
  managerName: string | null;
  deskName: string | null;
};

/**
 * "Where this lead stands", as a sentence and who has it.
 *
 * Read off the lead's own data and never typed: `who` is the seat that owes the
 * next move, so a Telecaller reading it knows whether it is theirs.
 */
export function stageStatus(f: StageStatusFacts): { text: string; who: string | null } {
  const desk = f.deskName;
  const mgr = f.managerName;
  switch (f.phase) {
    case "lost":
      return { text: "Closed as Lost", who: null };
    case "call1":
    case "call2":
    case "call3":
      return {
        text: `Calls in progress — Call ${nextCallNumber(f.phase)} of ${MAX_QUALIFICATION_CALLS} to make`,
        who: desk,
      };
    case "exhausted":
      return { text: "Three calls used and the required answers are still not in — close it", who: desk };
    case "ready":
      return { text: "Every required answer is in — request the Prospect", who: desk };
    case "requested":
      return { text: "Prospect requested — awaiting Sales Manager verification", who: mgr };
    case "followup":
      return { text: "On hold — Manager follow-up needed before the Prospect is confirmed", who: mgr };
    case "returned":
      return { text: "Verification failed — returned to the Telecaller", who: desk };
    case "prospect":
      return { text: "Prospect confirmed — qualification not started", who: mgr };
    case "qualification":
      return { text: `${f.qualDone} of ${f.qualTotal} qualification conditions done`, who: mgr };
    case "sample_trial":
      return {
        text:
          f.sampleState === "dispatched"
            ? "Sample dispatched — waiting for the customer to receive it"
            : f.sampleState === "received"
              ? "Sample received — trial review due"
              : "Sample requested — awaiting dispatch",
        who: mgr,
      };
    case "sample_received":
      return { text: "Sample received — trial review due", who: mgr };
    case "sample_review":
      return {
        text:
          f.trialOutcome === "approved"
            ? "Trial approved — ready for negotiation"
            : f.trialOutcome === "more_testing"
              ? "More testing required — another sample needed"
              : "Trial rejected — decide whether to close it",
        who: mgr,
      };
    case "negotiation":
      return {
        text: f.commitment ? `Commitment recorded: ${f.commitment}` : "Negotiating — no commitment recorded yet",
        who: mgr,
      };
    case "first_order":
      return { text: "1st order confirmed — delivery to arrange", who: mgr };
    case "delivery":
      return { text: "Delivered — payment due", who: mgr };
    case "payment":
      return { text: "Payment received — watch for the 2nd order", who: mgr };
    case "second_order":
      return { text: "2nd order placed — confirm as a Customer", who: mgr };
    case "customer":
      return { text: "Customer — a repeat buyer", who: mgr };
    case "parked":
      return { text: "On hold — parked, not lost", who: mgr };
    default:
      return { text: "Further along the funnel", who: mgr };
  }
}

/* ------------------------------------------------------------------ an answer, as a person reads it */

/**
 * A stored answer as it reads on screen — "800 Litres", "₹1,80,000", "30 days".
 *
 * The unit is part of the answer: a bare 800 beside "Monthly requirement" does
 * not say whether it is litres or cans, and the whole reason the figure is
 * stored in litres is that cans were the wrong thing to ask a prospect.
 */
export function displayAnswer(
  key: import("./engines/lead-calling-desk").DeskFieldKey,
  value: string | number | null | undefined,
  productName?: string | null,
  gstVerified?: boolean,
): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (key) {
    case "gstin":
      /* A GST number is a claim until somebody has checked it against the
         register, and the desk says which it is beside the number. */
      return `${value} ${gstVerified ? "(Verified)" : "(Awaiting check)"}`;
    case "monthlyLitres":
      return `${Number(value).toLocaleString("en-IN")} Litres`;
    case "potentialPaise":
      return `₹${Math.round(Number(value) / 100).toLocaleString("en-IN")}`;
    case "creditDaysWanted":
      return `${value} days`;
    case "requiredProductId":
      return productName ?? "Chosen";
    case "customerType":
      return String(value).charAt(0).toUpperCase() + String(value).slice(1);
    default:
      return String(value);
  }
}
