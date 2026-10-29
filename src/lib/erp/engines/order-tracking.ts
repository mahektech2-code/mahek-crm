/* ---------------------------------------------------------------------------
 * CUSTOMER ORDER TRACKING, as rules. Pure: no database, no clock.
 *
 * An order is tracked from the moment the back office confirms it to the
 * moment the party has the goods. Each STEP the customer is shown is a fact
 * some team already records — the back office's verification, every line
 * Ready, the invoice check, dispatch, and the Logistics desk's own steps — so
 * nothing here is typed by anybody: `deriveSteps` reads the facts and says
 * which steps are true and since when. The service records each step once
 * (`erp_order_milestones`), and the page is drawn from what was recorded.
 *
 * A step is never shown as done unless it was recorded (PRD §4.4), and the two
 * optional transport steps are never ticked because a later one was: a
 * transporter who reports nothing between "in transit" and "delivered" leaves
 * them unticked, said in one line.
 * ------------------------------------------------------------------------- */

/** Every step, in the order the customer meets them. `lr` is a document, not a stage (PRD §5). */
export const STEPS = ["confirmed", "preparing", "ready", "invoice", "dispatched", "at_transport", "lr", "in_transit", "at_destination", "out_for_delivery", "ready_for_pickup", "delivered"] as const;
export type Step = (typeof STEPS)[number];

/** The ten stages of the journey (PRD §5) — every step but the LR copy. */
export const STAGES: Step[] = STEPS.filter((s) => s !== "lr");

/** Shown only when the transporter reports them. */
export const OPTIONAL: ReadonlySet<Step> = new Set<Step>(["at_destination", "out_for_delivery", "ready_for_pickup"]);
/**
 * The last mile is one of two (0296): the transporter delivers to the door, or
 * the party collects from the transporter's office. Ready for pickup is never
 * offered as a step to come and never named as unreported — it is shown only
 * when it happened — and once it has, out for delivery is not waited on either.
 */
export const ALTERNATIVE: Step = "ready_for_pickup";

export const STEP_LABEL: Record<Step, string> = {
  confirmed: "Order Confirmed",
  preparing: "Preparing Your Order",
  ready: "Order Ready",
  invoice: "Invoice Available",
  dispatched: "Dispatched from Factory",
  at_transport: "Received by Transporter",
  lr: "LR copy available",
  in_transit: "In Transit",
  at_destination: "Reached Destination Transport Office",
  out_for_delivery: "Out for Delivery",
  ready_for_pickup: "Ready for Pickup",
  delivered: "Delivered to Customer",
};

export const STEP_WORDS: Record<Step, string> = {
  confirmed: "Your order has been confirmed.",
  preparing: "We are preparing your order.",
  ready: "Your goods are packed and ready.",
  invoice: "Your sales invoice is ready to view below.",
  dispatched: "Your goods have left our factory.",
  at_transport: "The transporter has accepted your goods.",
  lr: "The lorry receipt (LR) is ready to view below.",
  in_transit: "Your goods are on the way.",
  at_destination: "Your goods have reached the transporter's office near you.",
  out_for_delivery: "Your goods are on the way to your address.",
  ready_for_pickup: "Your goods are waiting at the transporter's office for you to collect.",
  delivered: "Delivery has been confirmed.",
};

export const isStep = (s: string): s is Step => (STEPS as readonly string[]).includes(s);

/* ================================================================ facts */

/** One live line of the order (cancelled lines are left out by the caller). */
export type LineFacts = {
  status: string;
  orderCheck: string;
  orderCheckedAt: string | null;
  partyStatus: string | null;
  createdAt: string;
  updatedAt: string;
  billed: boolean;
  billedAt: string | null;
  invoiceCheck: string | null;
  invoiceCheckedAt: string | null;
  dispatched: boolean;
  dispatchedAt: string | null;
};

/** One consignment the order left on, with the moments its shared events recorded. */
export type TransportFacts = {
  stage: string;
  atTransportAt: string | null;
  lrAttachedAt: string | null;
  delivered: boolean;
  deliveredAt: string | null;
  /** Shared events, oldest first: when each stage was first reached. */
  events: { kind: string; stage: string | null; at: string }[];
  /** Delivered in our own vehicle (0297): there is no transporter to hand it to, so that step never applies. */
  ownVehicle?: boolean;
};

/** The steps a delivery in our own vehicle never passes through. */
export const OWN_VEHICLE_SKIPS: ReadonlySet<Step> = new Set<Step>(["at_transport", "lr", "at_destination"]);

export type OrderFacts = { lines: LineFacts[]; transports: TransportFacts[] };

/** The Logistics stage a consignment is at, read as the customer's step. "On the way to destination" is still in transit. */
export function stepForStage(stage: string | null | undefined): Step | null {
  switch (stage) {
    case "At transport":
      return "at_transport";
    case "In Transit":
    case "On the way to Destination area":
      return "in_transit";
    case "Reached Destination Area":
      return "at_destination";
    case "Out for Delivery":
      return "out_for_delivery";
    case "Ready for Pickup":
      return "ready_for_pickup";
    case "Close - Received to Party":
      return "delivered";
    default:
      return null;
  }
}

const min = (xs: (string | null | undefined)[]): string | null => xs.filter((x): x is string => !!x).sort()[0] ?? null;
const max = (xs: (string | null | undefined)[]): string | null => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;

/** True from "confirmed" onward: the back office verified every live line and no line waits on a pending party. */
export function isConfirmed(lines: LineFacts[]): boolean {
  return lines.length > 0 && lines.every((l) => l.orderCheck === "Verified" && l.partyStatus !== "Pending");
}

/**
 * WHICH STEPS ARE TRUE NOW, and the best moment each became so. A moment the
 * records do not hold is null; the service then records the step at the time
 * it first saw it.
 *
 * - confirmed — every live line verified, no party waiting on approval.
 * - preparing — the same moment: verification is what hands the order to
 *   production (the floor has no per-order "started" mark to read earlier).
 * - ready — every live line Ready, billed or gone.
 * - invoice — billed and the check approved; or dispatched with the check not
 *   rejected (the check is optional, and goods leave with their invoice). A
 *   rejected invoice is never shown.
 * - dispatched — a line has left the factory.
 * - transport steps — a consignment reached that stage (first time, from its
 *   events), or a later one; the optional two only when actually reported.
 * - delivered — every consignment of the order is closed.
 */
export function deriveSteps(f: OrderFacts): Map<Step, string | null> {
  const out = new Map<Step, string | null>();
  const live = f.lines;
  if (!isConfirmed(live)) return out;
  /* Confirmed is the LATER of the back office's check and Accounts' approval of a
     pending party — the approval leaves no time of its own, so the line's last
     change stands for it. */
  const confirmedAt = max([...live.map((l) => l.orderCheckedAt), ...live.filter((l) => l.partyStatus === "Approved By Admin").map((l) => l.updatedAt)]);
  out.set("confirmed", confirmedAt);
  out.set("preparing", confirmedAt);

  const anyDispatched = live.some((l) => l.dispatched);
  if (live.every((l) => l.status === "Ready" || l.billed || l.dispatched)) out.set("ready", null);

  const billed = live.filter((l) => l.billed);
  if (billed.length && billed.length === live.length && billed.every((l) => l.invoiceCheck !== "Rejected")) {
    if (billed.every((l) => l.invoiceCheck === "Approved")) out.set("invoice", max(billed.map((l) => l.invoiceCheckedAt)));
    else if (anyDispatched) out.set("invoice", min(live.map((l) => l.dispatchedAt)));
  }
  if (anyDispatched) {
    out.set("dispatched", min(live.map((l) => l.dispatchedAt)));
    if (!out.has("ready")) out.set("ready", null);
  }

  const ts = f.transports;
  const rank = (s: Step) => STAGES.indexOf(s);
  /** The first moment any consignment reached exactly this step. */
  const reached = (step: Step): string | undefined => {
    let best: string | undefined;
    for (const t of ts) {
      const firstEvent = t.events.find((e) => stepForStage(e.stage) === step || (step === "at_transport" && e.kind === "at_transport"))?.at;
      const at = step === "at_transport" ? (t.atTransportAt ?? firstEvent) : firstEvent;
      if (at && (!best || at < best)) best = at;
    }
    return best;
  };
  /** The first moment any consignment reached this step or one after it — when a step is implied by a later one. */
  const reachedOrLater = (step: Step): string | null => {
    const later = ts.flatMap((t) => [...t.events.filter((e) => rank(stepForStage(e.stage) ?? "dispatched") > rank(step)).map((e) => e.at), t.lrAttachedAt, t.deliveredAt]);
    return min(later);
  };
  const furthest = ts.reduce((n, t) => Math.max(n, rank(stepForStage(t.stage) ?? "dispatched")), -1);
  if (ts.length && anyDispatched) {
    /* The transporter having the goods, and the goods moving, are implied by
       anything later — they cannot be skipped, only unreported. */
    const own = ts.every((t) => t.ownVehicle);
    for (const s of ["at_transport", "in_transit"] as Step[]) {
      if (own && OWN_VEHICLE_SKIPS.has(s)) continue;
      const at = reached(s);
      if (at !== undefined) out.set(s, at);
      else if (furthest >= rank(s)) out.set(s, reachedOrLater(s));
    }
    for (const s of ["at_destination", "out_for_delivery", "ready_for_pickup"] as Step[]) {
      const at = reached(s);
      if (at !== undefined) out.set(s, at);
    }
    const lrAt = min(ts.map((t) => t.lrAttachedAt));
    if (lrAt) out.set("lr", lrAt);
    if (ts.every((t) => t.delivered)) out.set("delivered", max(ts.map((t) => t.deliveredAt)) ?? reached("delivered") ?? null);
  }
  return out;
}

/* ============================================================ the journey */

export type Recorded = { step: Step; at: string; note?: string | null };
export type HoldRecord = {
  kind: "hold" | "delay";
  reason: string;
  customerText: string;
  raisedAt: string;
  nextUpdateOn: string | null;
  revisedDeliveryOn: string | null;
  resolvedAt: string | null;
  resolutionText: string | null;
};

export type JourneyEntry =
  | { type: "step"; step: Step; label: string; state: "done" | "current" | "pending"; at: string | null; words: string | null; optional: boolean }
  | { type: "hold"; label: string; at: string; words: string }
  | { type: "resolved"; label: string; at: string; words: string | null };

export type TrackingView = {
  /** The step the customer is at; null while nothing is recorded (verification undone). */
  current: Step | null;
  currentLabel: string;
  lastUpdated: string | null;
  openHold: HoldRecord | null;
  /** On a delivered order, the optional steps the transporter never reported — said in a line, never ticked. */
  unreported: Step[];
  entries: JourneyEntry[];
  /** Before dispatch, the transport steps are folded into one pending line so the page stays short. */
  folded: boolean;
};

/** Holds are titled by kind: an order held before it leaves, a delivery delayed after. */
export function holdTitle(kind: "hold" | "delay"): string {
  return kind === "hold" ? "Order On Hold" : "Delivery Delayed";
}

/**
 * What the page draws: the recorded steps in journey order, holds and their
 * resolutions among them by time, the current step marked, and what is still
 * to come as pending. Nothing is ticked that was not recorded.
 */
export function buildJourney(recorded: Recorded[], holds: HoldRecord[], reasonLabel: (code: string) => string = (c) => c, opts: { ownVehicle?: boolean } = {}): TrackingView {
  const byStep = new Map<Step, Recorded>();
  for (const r of recorded) if (!byStep.has(r.step) || byStep.get(r.step)!.at > r.at) byStep.set(r.step, r);
  const reachedStages = STAGES.filter((s) => byStep.has(s));
  const current = reachedStages.at(-1) ?? null;
  const delivered = byStep.has("delivered");
  const dispatched = byStep.has("dispatched");
  const curRank = current ? STAGES.indexOf(current) : -1;

  const timed: JourneyEntry[] = [];
  for (const s of STEPS) {
    const r = byStep.get(s);
    if (!r) continue;
    timed.push({ type: "step", step: s, label: STEP_LABEL[s], state: s === current && !delivered ? "current" : "done", at: r.at, words: r.note ?? STEP_WORDS[s], optional: OPTIONAL.has(s) });
  }
  for (const h of holds) {
    timed.push({ type: "hold", label: `${holdTitle(h.kind)} · ${reasonLabel(h.reason)}`, at: h.raisedAt, words: h.customerText });
    if (h.resolvedAt) timed.push({ type: "resolved", label: h.kind === "hold" ? "Hold resolved" : "Delay resolved", at: h.resolvedAt, words: h.resolutionText });
  }
  /* Steps in journey order; a hold slots in by time. Order by time, keeping journey order for a tie. */
  const order = (e: JourneyEntry) => (e.type === "step" ? STEPS.indexOf(e.step) : 99);
  timed.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || order(a) - order(b));
  if (delivered && timed.length) {
    const last = timed.findLast((e) => e.type === "step" && e.step === "delivered");
    if (last && last.type === "step") last.state = "done";
  }

  const pending: JourneyEntry[] = [];
  let folded = false;
  if (!delivered) {
    for (const s of STAGES) {
      if (byStep.has(s) || STAGES.indexOf(s) <= curRank || s === ALTERNATIVE) continue;
      if (opts.ownVehicle && OWN_VEHICLE_SKIPS.has(s)) continue;
      if (!dispatched && STAGES.indexOf(s) > STAGES.indexOf("dispatched")) {
        folded = true;
        continue;
      }
      pending.push({ type: "step", step: s, label: STEP_LABEL[s], state: "pending", at: null, words: OPTIONAL.has(s) ? "If the transporter reports it" : null, optional: OPTIONAL.has(s) });
    }
  }
  const open = holds.find((h) => !h.resolvedAt) ?? null;
  const times = [...recorded.map((r) => r.at), ...holds.flatMap((h) => [h.raisedAt, h.resolvedAt])].filter((x): x is string => !!x).sort();
  return {
    current,
    currentLabel: current ? STEP_LABEL[current] : "Order received — being checked",
    lastUpdated: times.at(-1) ?? null,
    openHold: open,
    unreported: delivered ? STAGES.filter((s) => OPTIONAL.has(s) && !byStep.has(s) && s !== ALTERNATIVE && !(s === "out_for_delivery" && byStep.has(ALTERNATIVE)) && !(opts.ownVehicle && OWN_VEHICLE_SKIPS.has(s))) : [],
    entries: [...timed, ...pending],
    folded,
  };
}

/* ============================================================ holds */

export type HoldReason = { code: string; label: string; kind: "hold" | "delay" | "both"; sentence: string };

/** PRD §7's reasons, with the sentence the customer reads. Admins may reword a sentence (`erp.tracking.holdMessages`). */
export const HOLD_REASONS: HoldReason[] = [
  { code: "payment_pending", label: "Payment pending", kind: "hold", sentence: "Your order is temporarily on hold because payment confirmation is pending." },
  { code: "material_shortage", label: "Material shortage", kind: "hold", sentence: "Your order is delayed because one or more required materials are currently unavailable. We will update you when preparation can continue." },
  { code: "quality_check", label: "Quality check hold", kind: "hold", sentence: "Your order is undergoing an additional quality check. We will update you as soon as it is cleared." },
  { code: "production_delay", label: "Production delay", kind: "hold", sentence: "Preparation of your order is taking longer than planned. We will update you when it is ready." },
  { code: "customer_requested", label: "Customer requested hold", kind: "hold", sentence: "Your order is on hold as you requested. Let us know when you would like us to continue." },
  { code: "transporter_delay", label: "Transporter delay", kind: "delay", sentence: "The transporter has reported a delay. We will update the expected delivery date when it is confirmed." },
  { code: "route_delay", label: "Road block / route delay", kind: "delay", sentence: "Delivery is delayed due to a route disruption. We will share an update when more information is available." },
  { code: "vehicle_breakdown", label: "Vehicle breakdown", kind: "delay", sentence: "Delivery is delayed because the vehicle carrying your goods broke down. We will update you when it is moving again." },
  { code: "other", label: "Other", kind: "both", sentence: "" },
];

export function reasonsFor(kind: "hold" | "delay"): HoldReason[] {
  return HOLD_REASONS.filter((r) => r.kind === kind || r.kind === "both");
}

export function reasonLabel(code: string): string {
  return HOLD_REASONS.find((r) => r.code === code)?.label ?? code;
}

export function reasonByLabel(label: string): HoldReason | null {
  const t = label.trim().toLowerCase();
  return HOLD_REASONS.find((r) => r.label.toLowerCase() === t || r.code === t) ?? null;
}

/** The sentence a reason starts with: the admins' wording where they set one, else the shipped one. */
export function sentenceFor(code: string, overrides: Record<string, string> | null | undefined): string {
  const own = overrides?.[code]?.trim();
  return own || HOLD_REASONS.find((r) => r.code === code)?.sentence || "";
}

/** The Logistics desk's internal problem, read as the reason a customer may be told. Null: not a delay the customer sees as one. */
export function delayReasonForIssue(issue: string): string | null {
  return issue === "Delayed" || issue === "Held at transport" ? "transporter_delay" : null;
}

export type HoldInput = { kind: "hold" | "delay"; reason: string; customerText: string; internalNote?: string | null; nextUpdateOn?: string | null; revisedDeliveryOn?: string | null };

/** Why this hold cannot be recorded, as a field and a sentence; null where it can. */
export function holdRefusal(h: HoldInput, today: string): { field: string; message: string } | null {
  const r = HOLD_REASONS.find((x) => x.code === h.reason);
  if (!r || (r.kind !== h.kind && r.kind !== "both")) return { field: "reason", message: "Pick the reason" };
  const text = h.customerText.trim();
  if (text.length < 10) return { field: "customerText", message: h.reason === "other" ? "Write the reason the customer will read" : "Write the message the customer will read" };
  if (text.length > 400) return { field: "customerText", message: "Keep the customer's message under 400 characters" };
  if (h.nextUpdateOn && h.nextUpdateOn < today) return { field: "nextUpdateOn", message: "The next update cannot be in the past" };
  if (h.revisedDeliveryOn && h.revisedDeliveryOn < today) return { field: "revisedDeliveryOn", message: "A revised delivery date cannot be in the past" };
  return null;
}

/* ============================================================ products */

export type ProductFacts = { name: string; goodName: string | null; qtyCans: number; litresPerCan: number | null; cansPerBox: number; boxed: boolean; drum: boolean };
export type ProductRow = { name: string; qty: number; unit: string; pack: string | null; measure: string | null };

const trim = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));

/**
 * One row per line, never added across lines (PRD §3: no quantities combined
 * across units). The quantity is what we sell — cans, or drums — with the
 * pack size and the litres beside it.
 */
export function productRows(lines: ProductFacts[]): ProductRow[] {
  return lines.map((l) => {
    const unit = l.drum ? (l.qtyCans === 1 ? "Drum" : "Drums") : l.qtyCans === 1 ? "Can" : "Cans";
    const size = l.litresPerCan ? `${trim(l.litresPerCan)} L ${l.drum ? "drum" : "can"}` : null;
    const boxes = l.boxed && l.cansPerBox > 1 ? Math.floor(l.qtyCans / l.cansPerBox) : 0;
    const loose = l.boxed && l.cansPerBox > 1 ? l.qtyCans % l.cansPerBox : 0;
    const boxWords = boxes ? `${boxes} box${boxes === 1 ? "" : "es"}${loose ? ` + ${loose}` : ""}` : null;
    const litres = l.litresPerCan ? l.qtyCans * l.litresPerCan : null;
    return {
      name: customerProductName(l.goodName ?? l.name),
      qty: l.qtyCans,
      unit,
      pack: [size, boxWords].filter(Boolean).join(" · ") || null,
      measure: litres != null ? `${trim(litres)} Litre` : null,
    };
  });
}

/** "Nano Thinner - 5 Liter (6 Can/Box)" → "Nano Thinner": the size is said in its own column. */
export function customerProductName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*-\s*[\d.]+\s*(liter|litre|ltr|l|kg)\b.*$/i, "").trim() || name;
}

/* ============================================================ messages */

export type TrackMessageKind = "confirmed" | "invoice" | "dispatched" | "hold" | "resolved";

export type TrackMessageFacts = {
  party: string;
  orderNo: number;
  orderDate: string;
  products: ProductRow[];
  trackUrl: string | null;
  invoiceNo?: string | null;
  holdTitle?: string | null;
  holdText?: string | null;
  nextUpdate?: string | null;
  revised?: string | null;
  resolution?: string | null;
  signature: string;
};

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "28 Oct 2026" for a YYYY-MM-DD date. */
export function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MO[m - 1]} ${y}`;
}

/** The WhatsApp the customer gets. Every figure in it is on the record; nothing is guessed. */
export function trackMessage(kind: TrackMessageKind, f: TrackMessageFacts): string {
  const lines: string[] = [];
  if (kind === "confirmed") {
    lines.push("Thank you for your order!", "", "Your order has been confirmed by Mahek Marketing India.", "", `Order Number: ${f.orderNo}`, `Order Date: ${longDay(f.orderDate)}`, "", "Order Details");
    for (const p of f.products) lines.push(`• ${p.name}${p.pack ? ` (${p.pack})` : ""} — ${p.qty} ${p.unit}`);
    if (f.trackUrl) lines.push("", `Track your order: ${f.trackUrl}`);
    lines.push("", "Thank you for choosing Mahek Marketing India.");
    return lines.join("\n");
  }
  lines.push(`Dear ${f.party},`, "");
  if (kind === "invoice") lines.push(`The sales invoice for your order ${f.orderNo}${f.invoiceNo ? ` (${f.invoiceNo})` : ""} is ready. You can view it on the tracking page.`);
  else if (kind === "dispatched") lines.push(`Update on order ${f.orderNo}: your goods have been dispatched from our factory.`);
  else if (kind === "hold") {
    lines.push(`${f.holdTitle ?? "Update"} — order ${f.orderNo}`, f.holdText ?? "");
    if (f.revised) lines.push(`New expected delivery: ${longDay(f.revised)}.`);
    else if (f.nextUpdate) lines.push(`We will update you by ${longDay(f.nextUpdate)}.`);
  } else lines.push(`Good news about order ${f.orderNo}: ${f.resolution?.trim() || "the hold has been cleared and we are continuing with your order."}`);
  if (f.trackUrl) lines.push("", `Track your order: ${f.trackUrl}`);
  lines.push("", `— ${f.signature}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The values a Wati template may ask for, by name. A template asking for anything else is sent by hand. */
export function trackWatiParams(f: TrackMessageFacts, body: string): Record<string, string> {
  return {
    name: f.party,
    party: f.party,
    order_no: String(f.orderNo),
    order_date: longDay(f.orderDate),
    items: f.products.map((p) => `${p.name} — ${p.qty} ${p.unit}`).join("; "),
    track_link: f.trackUrl ?? "",
    message: body.replace(/\s*\n+\s*/g, " ").trim(),
  };
}
