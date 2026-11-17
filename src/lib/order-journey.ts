/*
 * WHERE AN ORDER IS, from the TO number to the door — one reading for every
 * screen that shows it: TeleCRM's My orders, the order thread on the customer
 * record, and the Salesman App's order list and detail (which is sent these
 * words on the sync, never left to work them out). Pure and client-safe: the
 * facts are read by `services/order-journey-service.ts`.
 *
 * Every step is a fact somebody already recorded — the TO's two checks, the
 * order number, Accounts' and the Production Head's checks on the order's
 * lines, a hold on its desk, and the customer-tracking milestones. Nothing is
 * typed here and nothing is guessed: a step with no fact behind it is not
 * done.
 */

export type JourneyTone = "info" | "good" | "warn" | "bad" | "muted";

export type IntakeFacts = {
  toNo: number;
  /** open | correction | hold | verified | cancelled */
  status: string;
  takenAt: string;
  takenBy: string | null;
  backOfficeAt: string | null;
  backOfficeBy: string | null;
  productionAt: string | null;
  productionBy: string | null;
  correctionAt: string | null;
  correctionNote: string | null;
  heldAt: string | null;
  holdReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  orderNo: number | null;
};

export type HoldFacts = { department: string; reason: string; text: string; at: string; resolvedAt: string | null };

export type ErpOrderFacts = {
  orderNo: number;
  /** Summed over the order's live lines: Declined > Hold > Pending > Approved. */
  accountsCheck: string;
  accountsAt: string | null;
  accountsBy: string | null;
  /** Summed the same way: Hold > Pending > Cleared. */
  productionCheck: string;
  productionAt: string | null;
  productionBy: string | null;
  /** Every live line is cancelled. */
  cancelled: boolean;
  holds: HoldFacts[];
  /** The customer-tracking milestones that stand (`erp_order_milestones`). */
  milestones: { step: string; at: string; note: string | null }[];
};

/** The `orders` row in the book, for an order that never went through the hub. */
export type BookFacts = { status: string; at: string; approvedAt: string | null; declineReason: string | null };

export type JourneyFacts = { intake: IntakeFacts | null; order: ErpOrderFacts | null; book: BookFacts | null };

export type JourneyEvent = { at: string; text: string; tone: JourneyTone; where?: string };
export type StepState = "done" | "current" | "hold" | "todo";
export type JourneyStep = { key: string; label: string; state: StepState; at: string | null; note?: string };

export type Journey = {
  /** "TO-1042" until the order number exists, then "Order 5821". */
  title: string;
  toNo: number | null;
  orderNo: number | null;
  status: string;
  tone: JourneyTone;
  /** Only a TO that is open or sent back may be changed, by its taker or the hub. */
  editable: boolean;
  /** A sentence for the handset's banner, where there is something to say. */
  banner: string | null;
  events: JourneyEvent[];
  steps: JourneyStep[];
};

const DONE_MILESTONE: Record<string, string> = {
  ready: "Ready",
  invoice: "Billed",
  dispatched: "Dispatched",
  at_transport: "With the transporter",
  in_transit: "In transit",
  at_destination: "At the destination office",
  out_for_delivery: "Out for delivery",
  ready_for_pickup: "Ready for pickup",
  delivered: "Delivered",
};

/** The furthest milestone reached, in the order a consignment goes. */
const MILESTONE_ORDER = ["ready", "invoice", "dispatched", "at_transport", "in_transit", "at_destination", "out_for_delivery", "ready_for_pickup", "delivered"];

const DEPT: Record<string, string> = { office: "office", accounts: "accounts", production: "production" };

function furthest(ms: ErpOrderFacts["milestones"]): string | null {
  let best = -1;
  for (const m of ms) best = Math.max(best, MILESTONE_ORDER.indexOf(m.step));
  return best < 0 ? null : MILESTONE_ORDER[best];
}

const at = (ms: ErpOrderFacts["milestones"], step: string) => ms.find((m) => m.step === step)?.at ?? null;

export function journeyOf(f: JourneyFacts): Journey {
  const { intake, order, book } = f;
  const orderNo = order?.orderNo ?? intake?.orderNo ?? null;
  const toNo = intake?.toNo ?? null;
  const title = orderNo != null ? `Order ${orderNo}` : toNo != null ? `TO-${toNo}` : "Order";
  const events: JourneyEvent[] = [];
  const by = (who: string | null) => (who ? ` · ${who}` : "");

  if (intake) {
    events.push({ at: intake.takenAt, text: `Order taken${intake.takenBy ? ` by ${intake.takenBy}` : ""}`, tone: "info", where: `TO-${intake.toNo}` });
    if (intake.correctionAt) events.push({ at: intake.correctionAt, text: `Sent back for correction${intake.correctionNote ? `: ${intake.correctionNote}` : ""}`, tone: "warn", where: "Order Hub" });
    if (intake.backOfficeAt) events.push({ at: intake.backOfficeAt, text: `Checked by the back office${by(intake.backOfficeBy)}`, tone: "info", where: "Order Hub" });
    if (intake.productionAt) events.push({ at: intake.productionAt, text: `Checked by the Production Head${by(intake.productionBy)}${intake.orderNo != null ? `. Order number ${intake.orderNo} made.` : ""}`, tone: "info", where: "Order Hub" });
    if (intake.heldAt && intake.status === "hold") events.push({ at: intake.heldAt, text: `On hold at the office${intake.holdReason ? `: ${intake.holdReason}` : ""}`, tone: "bad", where: "To Hold" });
    if (intake.cancelledAt) events.push({ at: intake.cancelledAt, text: `Cancelled${intake.cancelReason ? `: ${intake.cancelReason}` : ""}`, tone: "bad" });
  } else if (book) {
    events.push({ at: book.at, text: "Order taken", tone: "info" });
  }
  if (order) {
    if (order.accountsAt && order.accountsCheck === "Approved") events.push({ at: order.accountsAt, text: `Approved by accounts${by(order.accountsBy)}`, tone: "good", where: "Order approvals" });
    if (order.accountsAt && order.accountsCheck === "Declined") events.push({ at: order.accountsAt, text: `Declined by accounts${by(order.accountsBy)}`, tone: "bad", where: "Order approvals" });
    for (const h of order.holds) {
      events.push({ at: h.at, text: `On hold · ${DEPT[h.department] ?? h.department}: ${h.text}`, tone: "bad", where: "To Hold" });
      if (h.resolvedAt) events.push({ at: h.resolvedAt, text: "Hold released", tone: "good", where: "To Hold" });
    }
    if (order.productionAt && order.productionCheck === "Cleared") events.push({ at: order.productionAt, text: `MRP cleared${by(order.productionBy)}`, tone: "good", where: "MRP check" });
    for (const m of order.milestones) if (DONE_MILESTONE[m.step]) events.push({ at: m.at, text: `${DONE_MILESTONE[m.step]}${m.note ? ` · ${m.note}` : ""}`, tone: m.step === "delivered" ? "good" : "info" });
  } else if (book?.approvedAt && !intake) {
    events.push({ at: book.approvedAt, text: book.status === "declined" ? `Declined by accounts${book.declineReason ? `: ${book.declineReason}` : ""}` : "Approved by accounts", tone: book.status === "declined" ? "bad" : "good" });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  /* ---- the one status word ---- */
  let status = "Order taken";
  let tone: JourneyTone = "info";
  let banner: string | null = null;
  const openHold = order?.holds.find((h) => !h.resolvedAt) ?? null;
  const reached = order ? furthest(order.milestones) : null;
  if (intake && intake.status !== "verified") {
    if (intake.status === "open") [status, tone] = ["Order check", "info"];
    else if (intake.status === "correction") {
      [status, tone] = ["Sent back", "warn"];
      banner = `Sent back for correction${intake.correctionNote ? `: "${intake.correctionNote}"` : ""}. Change it and send it again.`;
    } else if (intake.status === "hold") {
      [status, tone] = ["On hold · office", "bad"];
      banner = `On hold at the office${intake.holdReason ? `: ${intake.holdReason}` : ""}.`;
    } else if (intake.status === "cancelled") [status, tone] = ["Cancelled", "muted"];
  } else if (order) {
    if (order.cancelled) [status, tone] = ["Cancelled", "muted"];
    else if (reached === "delivered") [status, tone] = ["Delivered", "good"];
    else if (openHold) {
      [status, tone] = [`On hold · ${DEPT[openHold.department] ?? openHold.department}`, "bad"];
      banner = `${openHold.department === "accounts" ? "Accounts" : openHold.department === "production" ? "Production" : "The office"}: "${openHold.text}"`;
    } else if (order.accountsCheck === "Declined") [status, tone] = ["Declined by accounts", "bad"];
    else if (reached) [status, tone] = [DONE_MILESTONE[reached], "good"];
    else if (order.accountsCheck !== "Approved") [status, tone] = ["With accounts", "info"];
    else if (order.productionCheck !== "Cleared") [status, tone] = ["Production check", "info"];
    else [status, tone] = ["In production", "good"];
  } else if (book) {
    const w: Record<string, [string, JourneyTone]> = {
      pending_approval: ["With accounts", "info"],
      captured: ["With accounts", "info"],
      confirmed: ["Approved", "good"],
      dispatched: ["Dispatched", "good"],
      in_transit: ["In transit", "good"],
      delivered: ["Delivered", "good"],
      declined: ["Declined by accounts", "bad"],
      cancelled: ["Cancelled", "muted"],
    };
    [status, tone] = w[book.status] ?? [book.status, "info"];
  }

  /* ---- the handset's ladder ---- */
  const steps: JourneyStep[] = [];
  const checked = orderNo != null;
  steps.push({ key: "taken", label: "Taken", state: "done", at: intake?.takenAt ?? book?.at ?? null, note: toNo != null ? `TO-${toNo}` : undefined });
  if (intake) {
    const st: StepState = checked ? "done" : intake.status === "hold" || intake.status === "correction" ? "hold" : intake.status === "cancelled" ? "todo" : "current";
    steps.push({ key: "checked", label: checked ? `Order checked, order number ${orderNo}` : "Order check · back office and Production Head", state: st, at: intake.productionAt ?? intake.backOfficeAt });
  }
  const acc = order?.accountsCheck ?? (book ? (book.status === "declined" ? "Declined" : book.approvedAt ? "Approved" : "Pending") : "Pending");
  const accHold = openHold?.department === "accounts" || acc === "Hold";
  steps.push({
    key: "accounts",
    label: accHold ? "With accounts · on hold" : acc === "Declined" ? "Declined by accounts" : "Accounts",
    state: !checked && intake ? "todo" : acc === "Approved" ? "done" : accHold || acc === "Declined" ? "hold" : "current",
    at: order?.accountsAt ?? book?.approvedAt ?? (accHold ? openHold?.at ?? null : null),
  });
  if (order || intake) {
    const prodHold = openHold?.department === "production" || order?.productionCheck === "Hold";
    const pDone = order?.productionCheck === "Cleared";
    steps.push({ key: "production", label: prodHold ? "Production check · on hold" : "Production check", state: pDone ? "done" : prodHold ? "hold" : acc === "Approved" && order ? "current" : "todo", at: order?.productionAt ?? null });
  }
  const ms = order?.milestones ?? [];
  const billedAt = at(ms, "invoice");
  steps.push({ key: "billed", label: "Ready, billed", state: billedAt ? "done" : at(ms, "ready") ? "current" : "todo", at: billedAt ?? at(ms, "ready") });
  const deliveredAt = at(ms, "delivered");
  const dispatchedAt = at(ms, "dispatched");
  steps.push({ key: "dispatched", label: "Dispatched, delivered", state: deliveredAt ? "done" : dispatchedAt ? "current" : "todo", at: deliveredAt ?? dispatchedAt });

  return { title, toNo, orderNo, status, tone, editable: !!intake && (intake.status === "open" || intake.status === "correction"), banner, events, steps };
}

/** The tab a row of My orders belongs to. */
export type MyOrdersTab = "to" | "accounts" | "hold" | "moving" | "done";
export function tabOf(j: Journey): MyOrdersTab {
  if (j.status === "Cancelled" || j.status === "Delivered" || j.status.startsWith("Declined")) return "done";
  if (j.status.startsWith("On hold") || j.status === "Sent back") return "hold";
  if (j.orderNo == null && j.toNo != null) return "to";
  if (j.status === "With accounts") return "accounts";
  return "moving";
}

export const MY_ORDERS_TABS: { key: MyOrdersTab; label: string }[] = [
  { key: "to", label: "TO · being checked" },
  { key: "hold", label: "On hold or sent back" },
  { key: "accounts", label: "With accounts" },
  { key: "moving", label: "In production and on the way" },
  { key: "done", label: "Delivered or closed" },
];
