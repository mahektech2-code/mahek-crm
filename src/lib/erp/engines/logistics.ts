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
export const STAGES = ["Dispatched", "At transport", "In Transit", "On the way to Destination area", "Reached Destination Area", "Out for Delivery", "Ready for Pickup", "Close - Received to Party"] as const;
export type Stage = (typeof STAGES)[number];
export const CLOSED: Stage = "Close - Received to Party";
/** What a status update on the road may move to — reaching the party is its own act, with who signed. */
export const ROAD_STAGES: Stage[] = ["In Transit", "On the way to Destination area", "Reached Destination Area", "Out for Delivery", "Ready for Pickup"];
/**
 * 0296 — the last mile goes one of two ways: the transporter takes it to the
 * party's door, or the party comes to the transporter's office for it. They are
 * alternatives, not steps — a consignment ready for pickup never goes out for
 * delivery, so neither is read as later than the other.
 */
export const LAST_MILE: Stage[] = ["Out for Delivery", "Ready for Pickup"];
/** How many cities one update may add — a week of calls caught up at once, not a typo pasted twenty times. */
export const MAX_CITIES_PER_UPDATE = 12;

/** The short word on a board. */
export const STAGE_SHORT: Record<Stage, string> = {
  Dispatched: "Left factory",
  "At transport": "At transporter",
  "In Transit": "In transit",
  "On the way to Destination area": "Near destination",
  "Reached Destination Area": "At destination",
  /* 0292: the goods are on the local vehicle to the party's door — shown to the customer only when the transporter says so. */
  "Out for Delivery": "Out for delivery",
  /* 0296: waiting at the transporter's office for the party to collect it. */
  "Ready for Pickup": "Ready for pickup",
  "Close - Received to Party": "Delivered",
};

/**
 * The exceptions a consignment can carry (PRD step 12): delayed, incomplete
 * (damaged or short), held, a wrong address, refused by the party, or a
 * delivery nobody can confirm. Any of them makes the bill an Exception until
 * it is cleared or delivered.
 */
export const ISSUES = ["Delayed", "Damaged", "Short received", "Held at transport", "Wrong address", "Refused", "Unconfirmed", "Other"] as const;

export type Phase = "toTransport" | "lrPending" | "onRoad" | "delivered";

export const PHASE_LABEL: Record<Phase, string> = {
  toTransport: "Going to transporter",
  lrPending: "Waiting for LR",
  onRoad: "On the road",
  delivered: "Delivered",
};

/**
 * WHICH WAY THE FREIGHT IS PAID, read the way it is actually stored. The CRM
 * writes `paid` / `to_pay` (its form's enum), the history import wrote "To Pay",
 * and the ERP screens compared against "Paid" — which matched none of the 453
 * paid-freight parties on prod, so Paid freight was an empty tab while 248
 * lines a month waited on it. Every comparison goes through here.
 */
export function freightKey(term: string | null | undefined): "paid" | "to_pay" | "tbb" | null {
  const k = (term ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (k === "paid") return "paid";
  if (k === "to_pay" || k === "topay") return "to_pay";
  if (k === "tbb") return "tbb";
  return null;
}

export const isPaidFreight = (term: string | null | undefined): boolean => freightKey(term) === "paid";

/** The words for a screen: "Paid", "To Pay", "TBB", or what was stored when it is none of those. */
export function freightWord(term: string | null | undefined): string | null {
  const k = freightKey(term);
  return k === "paid" ? "Paid" : k === "to_pay" ? "To Pay" : k === "tbb" ? "TBB" : term?.trim() || null;
}

/* ------------------------------------------------- who delivers it */

/**
 * MAHEK'S OWN VEHICLE IS A RESERVED TRANSPORTER, by name. Orders, bills, LRs,
 * trips, loading and a party's default all carry the transporter as text, so a
 * delivery in our own vehicle is a bill whose transporter is this name and
 * nothing else changes shape. What differs is the proof: no LR, no stop at a
 * transporter's godown, and a customer-signed copy closes it (0301).
 */
export const MAHEK_VEHICLE = "Mahek Vehicle";

export function isMahekVehicle(transporter: string | null | undefined): boolean {
  return (transporter ?? "").trim().toLowerCase() === MAHEK_VEHICLE.toLowerCase();
}

/** The two kinds of delivery proof, and what each is called on a screen. */
export const PROOF_KINDS = ["lr", "signed_copy"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];
export const PROOF_WORD: Record<ProofKind, string> = { lr: "LR", signed_copy: "Signed copy" };
export const isProofKind = (v: unknown): v is ProofKind => v === "lr" || v === "signed_copy";

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
export function phaseOf(t: { lrNo: string | null; materialStage: string; transporter?: string | null }): Phase {
  if (t.materialStage === CLOSED) return "delivered";
  if (t.lrNo && t.lrNo.trim()) return "onRoad";
  /* Our own vehicle goes from the gate to the party: no transporter's godown, no LR to wait for. */
  if (isMahekVehicle(t.transporter)) return "onRoad";
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
  /** Our own vehicle's number, where the delivery is a Mahek Vehicle. */
  vehicleNo?: string | null;
  deliveredOn?: string | null;
  receivedBy?: string | null;
  note?: string | null;
  /** 0296 — the route: the city reached (and when), where it is going, and where to collect it. */
  city?: string | null;
  cityOn?: string | null;
  dispatchedFrom?: string | null;
  destination?: string | null;
  pickupPoint?: string | null;
  pickupContact?: string | null;
  signature: string;
};

/** What the customer is told the goods are doing, in their words. */
export function customerStageWords(stage: string, transporter: string | null, vehicleNo?: string | null): string {
  const own = isMahekVehicle(transporter);
  const by = own ? ` in our own vehicle${vehicleNo ? ` ${vehicleNo}` : ""}` : transporter ? ` with ${transporter}` : "";
  switch (stage) {
    case "Dispatched":
      return own ? `has left our factory${by}` : "has left our factory";
    case "At transport":
      return `has been handed over${by}`;
    case "In Transit":
      return `is in transit${by}`;
    case "On the way to Destination area":
      return "is on the way to your area";
    case "Reached Destination Area":
      return `has reached your area and will be delivered shortly`;
    case "Out for Delivery":
      return "is out for delivery to your address";
    case "Ready for Pickup":
      return `is ready for you to collect${transporter ? ` from ${transporter}` : ""}`;
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
    lines.push(`Update on ${billWords(f.bills)}: your consignment ${customerStageWords(f.stage, f.transporter, f.vehicleNo)}.`);
    const route = routeSentence(f);
    if (route) lines.push(route);
    if (f.stage === "Ready for Pickup" && f.pickupPoint) lines.push(`Collect it from: ${f.pickupPoint}${f.pickupContact ? ` (${f.pickupContact})` : ""}. Please carry the LR number.`);
    if (lr) lines.push(`${lr}${f.transporter ? ` (${f.transporter})` : ""}.`);
    if (f.note) lines.push(f.note);
    if (exp) lines.push(exp);
  } else if (kind === "issue") {
    lines.push(`About ${billWords(f.bills)}${lr ? ` (${lr})` : ""}: ${issueSentence(f.issue ?? "Other")}${f.issueNote ? ` — ${f.issueNote}` : ""}.`);
    lines.push(isMahekVehicle(f.transporter) ? "We are following it up with our driver and will update you." : "We are following it up with the transporter and will update you.");
    if (exp) lines.push(`New expected delivery: ${shortDay(f.expectedOn!)}.`);
  } else {
    lines.push(`Your consignment for ${billWords(f.bills)}${lr ? ` (${lr})` : ""} has been delivered${f.deliveredOn ? ` on ${shortDay(f.deliveredOn)}` : ""}${f.receivedBy ? `, received by ${f.receivedBy}` : ""}.`);
    lines.push("Thank you for your business. If anything is short or damaged, please reply here.");
  }
  if (f.trackUrl && kind !== "delivered") lines.push("", `Track it: ${f.trackUrl}`);
  lines.push("", `— ${f.signature}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Where the goods are on the way, in one line — only what somebody reported:
 * "Dispatched from Bhiwandi · reached Pune on Wed 30 Oct · going to Indore."
 */
export function routeSentence(f: Pick<MessageFacts, "city" | "cityOn" | "dispatchedFrom" | "destination" | "stage">): string | null {
  const parts: string[] = [];
  if (f.dispatchedFrom && (!f.city || f.city === f.dispatchedFrom)) parts.push(`Dispatched from ${f.dispatchedFrom}`);
  if (f.city && f.city !== f.dispatchedFrom) parts.push(`${parts.length ? "reached" : "Reached"} ${f.city}${f.cityOn ? ` on ${shortDay(f.cityOn)}` : ""}`);
  if (f.destination && !LAST_MILE.includes(f.stage as Stage) && f.stage !== "Reached Destination Area") parts.push(`${parts.length ? "going" : "Going"} to ${f.destination}`);
  return parts.length ? `${parts.join(" · ")}.` : null;
}

/** A place as typed on a call, tidied: trimmed, spaces collapsed, at most 80 characters. Empty is null. */
export function cleanPlace(v: string | null | undefined): string | null {
  const t = (v ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return t || null;
}

/**
 * The cities one update adds, checked: each a place and a day, none in the
 * future, none before the goods left, and the same city on the same day only
 * once. Returned oldest first, which is the order they were reached in.
 */
export function cleanCities(
  rows: { city?: string | null; on?: string | null }[] | null | undefined,
  today: string,
  leftOn: string | null,
): { ok: true; cities: { city: string; on: string }[] } | { ok: false; error: string } {
  const out: { city: string; on: string }[] = [];
  for (const r of rows ?? []) {
    const city = cleanPlace(r.city);
    const on = (r.on ?? "").trim();
    if (!city && !on) continue;
    if (!city) return { ok: false, error: "Name the city it reached" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return { ok: false, error: `Say the day it reached ${city}` };
    if (on > today) return { ok: false, error: `${city}: a city cannot be reached in the future` };
    if (leftOn && on < leftOn) return { ok: false, error: `${city}: the goods left on ${shortDay(leftOn)}, so they cannot have reached it before that` };
    if (!out.some((x) => x.city.toLowerCase() === city.toLowerCase() && x.on === on)) out.push({ city, on });
  }
  if (out.length > MAX_CITIES_PER_UPDATE) return { ok: false, error: `Add at most ${MAX_CITIES_PER_UPDATE} cities at a time` };
  return { ok: true, cities: out.sort((a, b) => a.on.localeCompare(b.on)) };
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
    case "Refused":
      return "the delivery was refused at the destination";
    case "Unconfirmed":
      return "we are still confirming that the consignment reached you";
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
    status: kind === "delivered" ? "delivered" : kind === "issue" ? issueSentence(f.issue ?? "Other") : customerStageWords(f.stage, f.transporter, f.vehicleNo),
    expected: f.expectedOn ? shortDay(f.expectedOn) : "",
    city: f.city ?? "",
    destination: f.destination ?? "",
    pickup_point: f.pickupPoint ?? "",
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

/**
 * Whether an upload row is an LR at all. No field is required, so a photo, a
 * number or any one detail is enough — and a row with nothing in it is skipped
 * rather than refused, because "+ Another LR" leaves one empty behind.
 */
export function lrRowHasAnything(r: {
  lrNo?: string | null;
  fileId?: string | null;
  transporter?: string | null;
  destination?: string | null;
  packages?: number | null;
  freightTerm?: string | null;
  freightRupees?: number | null;
  note?: string | null;
  /* A signed copy's own facts count too (0301). */
  billHint?: string | null;
  partyHint?: string | null;
  receivedBy?: string | null;
}): boolean {
  const t = (v: string | null | undefined) => !!(v ?? "").trim();
  return t(r.lrNo) || t(r.fileId) || t(r.transporter) || t(r.destination) || r.packages != null || t(r.freightTerm) || r.freightRupees != null || t(r.note) || t(r.billHint) || t(r.partyHint) || t(r.receivedBy);
}

/** An uploaded LR by name — one uploaded with only its photo has no number yet. */
export function lrUploadName(lrNo: string | null | undefined): string {
  return lrNo ? `LR ${lrNo}` : "LR (number not typed)";
}
