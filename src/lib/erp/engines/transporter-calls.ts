/* ---------------------------------------------------------------------------
 * CALLING A TRANSPORTER — the rules, pure.
 *
 * On the road is worked one transporter at a time: one call covers every LR
 * that company is carrying for us. A call ends one of four ways, and only two
 * of them can say anything about the goods:
 *
 *   update     they gave news — some LRs moved, and the customers hear of it
 *   no_change  they answered and nothing moved — the next call is booked
 *   no_answer  nobody picked up — the calls stay due
 *   call_back  "ring after four" — the next call is the time they gave
 *
 * News may also arrive without a call — the transporter's WhatsApp, or their
 * tracking page — and that is an update or nothing new, never unanswered.
 * ------------------------------------------------------------------------- */

import { addDays, daysBetween, shortDay, STAGE_SHORT, type Stage } from "./logistics";

export const CALL_OUTCOMES = ["update", "no_change", "no_answer", "call_back"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_SOURCES = ["call", "whatsapp", "tracking"] as const;
export type CallSource = (typeof CALL_SOURCES)[number];

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  update: "Gave an update",
  no_change: "Answered — nothing new",
  no_answer: "No answer / busy",
  call_back: "Asked to call back",
};

/** What the history calls a row, short. */
export const OUTCOME_TAG: Record<CallOutcome, string> = {
  update: "Update",
  no_change: "Nothing new",
  no_answer: "No answer",
  call_back: "Call back",
};

export const SOURCE_LABEL: Record<CallSource, string> = {
  call: "Phone call",
  whatsapp: "Their WhatsApp",
  tracking: "Their tracking page",
};

/** The outcomes a source can end in: only a phone call can go unanswered. */
export function outcomesFor(source: CallSource): CallOutcome[] {
  return source === "call" ? [...CALL_OUTCOMES] : ["update", "no_change"];
}

export function isOutcome(v: unknown): v is CallOutcome {
  return typeof v === "string" && (CALL_OUTCOMES as readonly string[]).includes(v);
}
export function isSource(v: unknown): v is CallSource {
  return typeof v === "string" && (CALL_SOURCES as readonly string[]).includes(v);
}

/** One key per transporter, the way the bills spell it however they space or case it. */
export function transporterKey(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** One LR as the call found it, and what the person typed for it. */
export type LrBefore = { lrNo: string | null; stage: string; expectedOn: string | null };
export type LrAfter = { stage: string; city: string; expectedOn: string };

/**
 * What moved on one LR, in words — or null when nothing did. A city alone is
 * news (it shows on the customer's page); a stage chosen that equals the one
 * it was at is not.
 */
export function lrChange(before: LrBefore, after: LrAfter): string | null {
  const parts: string[] = [];
  if (after.stage && after.stage !== before.stage) parts.push(`${stageWord(before.stage)} → ${stageWord(after.stage)}`);
  const city = after.city.replace(/\s+/g, " ").trim();
  if (city) parts.push(`Reached ${city}`);
  if (after.expectedOn && after.expectedOn !== before.expectedOn) parts.push(before.expectedOn ? `Expected ${shortDay(before.expectedOn)} → ${shortDay(after.expectedOn)}` : `Expected ${shortDay(after.expectedOn)}`);
  return parts.length ? parts.join(" · ") : null;
}

function stageWord(stage: string): string {
  return STAGE_SHORT[stage as Stage] ?? stage;
}

/**
 * The next call a save books. An update or nothing-new books the day picked,
 * else the configured gap. A call-back MUST name its day (today allowed). A
 * no-answer moves nothing unless a day was picked — the calls stay due.
 */
export function nextCallFor(outcome: CallOutcome, picked: string | null, today: string, callEveryDays: number): { ok: true; day: string | null } | { ok: false; error: string } {
  if (picked && picked < today) return { ok: false, error: "The next call cannot be in the past" };
  if (outcome === "call_back") return picked ? { ok: true, day: picked } : { ok: false, error: "Say when they asked you to call back" };
  if (outcome === "no_answer") return { ok: true, day: picked };
  return { ok: true, day: picked ?? addDays(today, callEveryDays) };
}

/** A logged call, as the history and the figures read it. */
export type CallRow = { outcome: CallOutcome; source: CallSource; /** The IST day it was logged — read in SQL with the zone named. */ day: string; changes: { lrNo: string | null; what: string }[] };

/**
 * The three figures over the window: calls made, how many of our calls were
 * answered (null with none — no rate from nothing), and how many times an
 * expected day was moved. A day moved is the transporter's promise slipping.
 */
export function callStats(rows: CallRow[], today: string, days = 30): { calls: number; answeredPct: number | null; datesMoved: number } {
  const inWindow = rows.filter((r) => daysBetween(r.day, today) <= days);
  const ours = inWindow.filter((r) => r.source === "call");
  const answered = ours.filter((r) => r.outcome === "update" || r.outcome === "no_change").length;
  const datesMoved = inWindow.reduce((a, r) => a + r.changes.filter((c) => /Expected .+ → /.test(c.what)).length, 0);
  return { calls: ours.length, answeredPct: ours.length ? Math.round((answered / ours.length) * 100) : null, datesMoved };
}
