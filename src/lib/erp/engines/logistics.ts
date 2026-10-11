/* ---------------------------------------------------------------------------
 * THE LOGISTICS FLOW, as rules. Pure: no database, no clock — the business date
 * comes in as an argument, like every engine here.
 *
 *   factory ─dispatch─▶ to the transporter (Bhiwandi) ─reached─▶ waiting for LR
 *     ─LR uploaded by dispatch, attached by logistics─▶ on the road
 *     ─called, updated, customer told─▶ … ─▶ received by the party (closed)
 *
 * A bill's PHASE is derived from two facts it already carries — its stage and
 * whether it has an LR — never stored, so the desk and the old list cannot
 * disagree about where a bill is.
 * ------------------------------------------------------------------------- */

import { similarity } from "./match";

/**
 * Where a consignment is. The first and the last three are Mahek Plus's own
 * words and stay byte for byte — the order book and the CRM read them.
 * "At transport" is new: the transporter's godown has the goods and the LR has
 * not come yet.
 */
export const STAGES = ["Dispatched", "At transport", "In Transit", "On the way to Destination area", "Reached Destination Area", "Close - Received to Party"] as const;
export type Stage = (typeof STAGES)[number];
export const CLOSED: Stage = "Close - Received to Party";
/** What a status update on the road may move to — reaching the party is its own act, with who signed. */
export const ROAD_STAGES: Stage[] = ["In Transit", "On the way to Destination area", "Reached Destination Area"];

/** The short word on a board. */
export const STAGE_SHORT: Record<Stage, string> = {
  Dispatched: "Left factory",
  "At transport": "At transporter",
  "In Transit": "In transit",
  "On the way to Destination area": "Near destination",
  "Reached Destination Area": "At destination",
  "Close - Received to Party": "Delivered",
};

export const ISSUES = ["Delayed", "Damaged", "Short received", "Held at transport", "Wrong address", "Other"] as const;

export type Phase = "toTransport" | "lrPending" | "onRoad" | "delivered";

export const PHASE_LABEL: Record<Phase, string> = {
  toTransport: "Going to transporter",
  lrPending: "Waiting for LR",
  onRoad: "On the road",
  delivered: "Delivered",
};

export function isStage(s: string | null | undefined): s is Stage {
  return !!s && (STAGES as readonly string[]).includes(s);
}

/** 0 for "Dispatched" … 5 for delivered; an unknown legacy word reads as the start. */
export function stageStep(stage: string | null | undefined): number {
  const i = STAGES.indexOf(stage as Stage);
  return i < 0 ? 0 : i;
}

/**
 * The phase is the stage and the LR together. A bill somebody moved to "In
 * Transit" on the old screen without an LR is still waiting for its LR — the
 * customer cannot be told anything about a lorry nobody can name.
 */
export function phaseOf(t: { lrNo: string | null; materialStage: string }): Phase {
  if (t.materialStage === CLOSED) return "delivered";
  if (t.lrNo && t.lrNo.trim()) return "onRoad";
  return stageStep(t.materialStage) >= 1 ? "lrPending" : "toTransport";
}

/* ------------------------------------------------------------------ dates */

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  // A date-only value moved in UTC and read back in UTC — no wall clock involved.
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 12 Oct". */
export function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}

/** A due date the way the floor says it: Today, Tomorrow, Late by 2 days, or the day. */
export function dueWord(due: string | null | undefined, today: string): { word: string; tone: "danger" | "warn" | "neutral" } | null {
  if (!due) return null;
  const n = daysBetween(today, due);
  if (n === 0) return { word: "Today", tone: "warn" };
  if (n === 1) return { word: "Tomorrow", tone: "neutral" };
  if (n < 0) return { word: `Late by ${-n} day${n === -1 ? "" : "s"}`, tone: "danger" };
  return { word: shortDay(due), tone: "neutral" };
}

/** A call to the transporter is owed: the day has come and the goods have not reached the party. */
export function callDue(t: { reminderDate: string | null; materialStage: string }, today: string): boolean {
  return !!t.reminderDate && t.reminderDate <= today && t.materialStage !== CLOSED;
}

/** On the road longer than anybody expected: past its expected day, or older than the limit with none. */
export function runningLate(t: { expectedDeliveryOn: string | null; billDate: string | null; materialStage: string }, today: string, lateAfterDays: number): boolean {
  if (t.materialStage === CLOSED) return false;
  if (t.expectedDeliveryOn) return t.expectedDeliveryOn < today;
  return !!t.billDate && daysBetween(t.billDate, today) > lateAfterDays;
}

/* ------------------------------------------------------- the LR desk */

export type LrFacts = { transporter: string | null; packages: number | null; destination: string | null };
export type LrCandidate = { id: string; transporter: string | null; packages: number | null; area: string | null; party: string; atTransport: boolean };

/**
 * Which waiting bills an uploaded LR most likely carries, best first. A
 * suggestion, never a decision: the transporter named alike, the destination
 * naming the bill's area or party, the box count matching, and the bill having
 * actually reached the transporter. Nothing is attached by this.
 */
export function rankForLr(lr: LrFacts, cands: LrCandidate[]): { id: string; score: number; reasons: string[] }[] {
  const out = cands.map((c) => {
    let score = 0;
    const reasons: string[] = [];
    if (lr.transporter && c.transporter) {
      const s = Math.max(similarity(lr.transporter, c.transporter), similarity(c.transporter, lr.transporter));
      if (s >= 0.5) {
        score += 4;
        reasons.push("same transporter");
      } else score -= 2;
    }
    if (lr.destination) {
      const d = Math.max(c.area ? similarity(c.area, lr.destination) : 0, similarity(lr.destination, c.party));
      if (d >= 0.5) {
        score += 3;
        reasons.push("destination matches");
      }
    }
    if (lr.packages != null && c.packages != null && lr.packages === c.packages) {
      score += 2;
      reasons.push(`${c.packages} boxes`);
    }
    if (c.atTransport) {
      score += 1;
      reasons.push("at the transporter");
    }
    return { id: c.id, score, reasons };
  });
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Can these bills travel under one LR? One LR is one consignee, so the bills
 * must go to one delivery party; a bill already under another LR, or closed,
 * cannot be moved by attaching.
 */
export function attachRefusal(
  bills: { id: string; orderNo: number; deliveryPartyId: string; lrId: string | null; materialStage: string }[],
  lrId: string,
): string | null {
  if (!bills.length) return "Tick the bills this LR carries.";
  const parties = new Set(bills.map((b) => b.deliveryPartyId));
  if (parties.size > 1) return "One LR goes to one party. These bills go to different parties — attach them to their own LRs.";
  const other = bills.find((b) => b.lrId && b.lrId !== lrId);
  if (other) return `Bill of order ${other.orderNo} is already under another LR. Take it off that LR first.`;
  const closed = bills.find((b) => b.materialStage === CLOSED);
  if (closed) return `Order ${closed.orderNo} has already reached the party.`;
  return null;
}

/* --------------------------------------------------- telling the customer */

export type MessageKind = "lr" | "stage" | "issue" | "delivered";

export type MessageFacts = {
  party: string;
  bills: string[];
  lrNo: string | null;
  lrDate: string | null;
  transporter: string | null;
  packages: number | null;
  stage: string;
  expectedOn: string | null;
  trackUrl: string | null;
  issue?: string | null;
  issueNote?: string | null;
  deliveredOn?: string | null;
  receivedBy?: string | null;
  note?: string | null;
  signature: string;
};

/** What the customer is told the goods are doing, in their words. */
export function customerStageWords(stage: string, transporter: string | null): string {
  const by = transporter ? ` with ${transporter}` : "";
  switch (stage) {
    case "Dispatched":
      return "has left our factory";
    case "At transport":
      return `has been handed over${by}`;
    case "In Transit":
      return `is in transit${by}`;
    case "On the way to Destination area":
      return "is on the way to your area";
    case "Reached Destination Area":
      return `has reached your area and will be delivered shortly`;
    case CLOSED:
      return "has been delivered";
    default:
      return `is ${stage.toLowerCase()}`;
  }
}

function billWords(bills: string[]): string {
  const b = bills.filter(Boolean);
  if (!b.length) return "your order";
  return b.length === 1 ? `bill ${b[0]}` : `bills ${b.slice(0, -1).join(", ")} and ${b[b.length - 1]}`;
}

/**
 * The WhatsApp a customer gets at each step. Every figure in it is a fact on
 * the record — a box count nobody entered or a date nobody gave is left out
 * rather than guessed, so the sentence never claims more than we know.
 */
export function customerMessage(kind: MessageKind, f: MessageFacts): string {
  const lines: string[] = [`Dear ${f.party},`, ""];
  const lr = f.lrNo ? `LR no ${f.lrNo}${f.lrDate ? ` dated ${shortDay(f.lrDate)}` : ""}` : null;
  const boxes = f.packages != null && f.packages > 0 ? `${f.packages} box${f.packages === 1 ? "" : "es"}` : null;
  const exp = f.expectedOn ? `Expected delivery: ${shortDay(f.expectedOn)}.` : null;
  if (kind === "lr") {
    lines.push(`Your goods for ${billWords(f.bills)} have been booked${f.transporter ? ` with ${f.transporter}` : ""}.`);
    lines.push([lr, boxes].filter(Boolean).join(" · ") + ".");
    if (exp) lines.push(exp);
  } else if (kind === "stage") {
    lines.push(`Update on ${billWords(f.bills)}: your consignment ${customerStageWords(f.stage, f.transporter)}.`);
    if (lr) lines.push(`${lr}${f.transporter ? ` (${f.transporter})` : ""}.`);
    if (f.note) lines.push(f.note);
    if (exp) lines.push(exp);
  } else if (kind === "issue") {
    lines.push(`About ${billWords(f.bills)}${lr ? ` (${lr})` : ""}: ${issueSentence(f.issue ?? "Other")}${f.issueNote ? ` — ${f.issueNote}` : ""}.`);
    lines.push("We are following it up with the transporter and will update you.");
    if (exp) lines.push(`New expected delivery: ${shortDay(f.expectedOn!)}.`);
  } else {
    lines.push(`Your consignment for ${billWords(f.bills)}${lr ? ` (${lr})` : ""} has been delivered${f.deliveredOn ? ` on ${shortDay(f.deliveredOn)}` : ""}${f.receivedBy ? `, received by ${f.receivedBy}` : ""}.`);
    lines.push("Thank you for your business. If anything is short or damaged, please reply here.");
  }
  if (f.trackUrl && kind !== "delivered") lines.push("", `Track it: ${f.trackUrl}`);
  lines.push("", `— ${f.signature}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function issueSentence(issue: string): string {
  switch (issue) {
    case "Delayed":
      return "the consignment is delayed";
    case "Damaged":
      return "part of the consignment was reported damaged";
    case "Short received":
      return "the consignment was reported short";
    case "Held at transport":
      return "the consignment is held at the transporter";
    case "Wrong address":
      return "the transporter has an address problem with the delivery";
    default:
      return "there is a problem with the consignment";
  }
}

/**
 * The values a Wati template may ask for, by the names logistics templates are
 * expected to use. A template asking for anything else is refused by the
 * caller rather than sent with a blank in it.
 */
export function watiParams(kind: MessageKind, f: MessageFacts, body: string): Record<string, string> {
  return {
    name: f.party,
    party: f.party,
    bill_no: f.bills.join(", "),
    lr_no: f.lrNo ?? "",
    lr_date: f.lrDate ? shortDay(f.lrDate) : "",
    transporter: f.transporter ?? "",
    boxes: f.packages != null ? String(f.packages) : "",
    status: kind === "delivered" ? "delivered" : kind === "issue" ? issueSentence(f.issue ?? "Other") : customerStageWords(f.stage, f.transporter),
    expected: f.expectedOn ? shortDay(f.expectedOn) : "",
    track_link: f.trackUrl ?? "",
    message: body.replace(/\s*\n+\s*/g, " ").trim(),
  };
}

/** A wa.me link with the text in it — the manual way out when Wati cannot send. */
export function waLink(phone: string | null, body: string): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const to = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${to}?text=${encodeURIComponent(body)}`;
}

/** A transporter's own tracking page for an LR, where its address carries {lr}. */
export function trackingLink(template: string | null | undefined, lrNo: string | null): string | null {
  if (!template || !lrNo || !/^https?:\/\//.test(template)) return null;
  return template.includes("{lr}") ? template.replaceAll("{lr}", encodeURIComponent(lrNo)) : template;
}

/**
 * Packages a bill leaves as: a boxed SKU counts its boxes (part boxes round
 * up), a loose one counts its cans or drums.
 */
export function packagesOf(lines: { qtyCans: number; cansPerBox: number | null; boxed: boolean }[]): number {
  return lines.reduce((n, l) => n + (l.boxed && (l.cansPerBox ?? 0) > 1 ? Math.ceil(l.qtyCans / (l.cansPerBox as number)) : l.qtyCans), 0);
}
