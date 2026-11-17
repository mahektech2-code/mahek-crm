/* ---------------------------------------------------------------------------
 * THE ORDER HUB'S RULES — pure, so the screens and the server ask the same
 * questions and the tests need no database.
 *
 * An order starts as a TEMPORARY ORDER (a TO number) wherever it was taken.
 * Two checks — the back office and the Production Head — and the SECOND one
 * makes the order number. After it, two gates before production: Accounts
 * approve the order, and the Production Head clears it against materials and
 * capacity (the MRP check). Nothing about the order may be edited once it has
 * its order number; cancelling, holding and the rest keep the rules they had.
 * ------------------------------------------------------------------------- */

export const INTAKE_STATUSES = ["open", "correction", "hold", "verified", "cancelled"] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const INTAKE_STATUS_LABEL: Record<IntakeStatus, string> = {
  open: "Waiting for checks",
  correction: "Sent back for correction",
  hold: "On hold",
  verified: "Order number made",
  cancelled: "Cancelled",
};

/** Where a TO came from, as the hub shows it. ERP orders keep the source typed on the form. */
export const ORIGIN_SOURCE = { crm: "TeleCRM", mbos: "Salesman App" } as const;

export type CheckKind = "backOffice" | "production";
export const CHECK_LABEL: Record<CheckKind, string> = { backOffice: "Back office", production: "Production Head" };

export type IntakeChecks = {
  status: IntakeStatus | string;
  backOfficeById: string | null;
  productionById: string | null;
};

export type Checker = {
  userId: string;
  /** Holds the back office's verify power. */
  backOffice: boolean;
  /** Holds the Production Head's check power. */
  production: boolean;
  /** An ERP administrator: holds both powers, and may make both checks. */
  admin: boolean;
};

/** A TO can be changed — lines, party, anything — only before it has its order number. */
export function intakeEditable(status: string): boolean {
  return status === "open" || status === "correction";
}

/**
 * WHICH CHECK this person's Verify makes, or why they cannot make one.
 *
 * The two checks are two people: somebody who made one of them cannot make
 * the other, so a TO never reaches its order number on one person's say-so —
 * an administrator excepted, the same exception the invoice check makes.
 * Somebody holding both powers makes whichever is still owed, the Production
 * Head's first.
 */
export function nextCheck(i: IntakeChecks, who: Checker): { ok: true; check: CheckKind } | { ok: false; why: string } {
  if (i.status === "verified") return { ok: false, why: "It already has its order number" };
  if (i.status === "cancelled") return { ok: false, why: "It is cancelled" };
  if (i.status === "hold") return { ok: false, why: "It is on hold; release it first" };
  if (i.status === "correction") return { ok: false, why: "It is waiting for a correction from whoever took it" };
  const canBack = who.backOffice || who.admin;
  const canProd = who.production || who.admin;
  if (!canBack && !canProd) return { ok: false, why: "Only the back office or the Production Head verifies a TO" };
  const backDone = !!i.backOfficeById;
  const prodDone = !!i.productionById;
  const didOne = !who.admin && (i.backOfficeById === who.userId || i.productionById === who.userId);
  if (didOne) return { ok: false, why: "You made the other check; somebody else makes this one" };
  if (canProd && !prodDone) return { ok: true, check: "production" };
  if (canBack && !backDone) return { ok: true, check: "backOffice" };
  if (!canProd && prodDone && !backDone) return { ok: false, why: "Waiting for the back office" };
  if (!canBack && backDone && !prodDone) return { ok: false, why: "Waiting for the Production Head" };
  return { ok: false, why: "Both checks are done" };
}

/** True once both checks are on the TO: the moment the order number is made. */
export function bothChecked(i: { backOfficeById: string | null; productionById: string | null }): boolean {
  return !!i.backOfficeById && !!i.productionById;
}

/* ------------------------------------------------------------- the gates */

export type GateFacts = { accountsCheck: string; productionCheck: string };

/** Approved by Accounts and cleared by the Production Head: the line may be made, marked Ready and billed. */
export function lineCleared(l: GateFacts): boolean {
  return l.accountsCheck === "Approved" && l.productionCheck === "Cleared";
}

/** Why a line may not move into production yet, in words, or null. */
export function gateRefusal(l: GateFacts): string | null {
  if (l.accountsCheck === "Declined") return "Accounts declined it";
  if (l.accountsCheck === "Hold") return "It is on hold with Accounts";
  if (l.accountsCheck !== "Approved") return "Accounts have not approved it yet";
  if (l.productionCheck === "Hold") return "It is on hold with the Production Head";
  if (l.productionCheck !== "Cleared") return "The Production Head has not cleared it yet";
  return null;
}

/** Where an order is in the hub's flow, after its order number: one word per stage. */
export function gateStage(l: GateFacts): "accounts" | "accountsHold" | "mrp" | "mrpHold" | "cleared" | "declined" {
  if (l.accountsCheck === "Declined") return "declined";
  if (l.accountsCheck === "Hold") return "accountsHold";
  if (l.accountsCheck !== "Approved") return "accounts";
  if (l.productionCheck === "Hold") return "mrpHold";
  if (l.productionCheck !== "Cleared") return "mrp";
  return "cleared";
}

/* ------------------------------------------------------------- holds */

/** The desks that hold an order. A TO's hold is the hub's (order verification); an order's is one of these. */
export const HOLD_DEPARTMENTS = ["verification", "accounts", "production", "office"] as const;
export type HoldDepartment = (typeof HOLD_DEPARTMENTS)[number];

export const DEPARTMENT_LABEL: Record<HoldDepartment, string> = {
  verification: "Order verification",
  accounts: "Accounts",
  production: "Production (MRP)",
  office: "Office",
};

/** Where releasing a hold sends the order, in words — it is checked again there, never skipped ahead. */
export const RELEASE_TO: Record<HoldDepartment, string> = {
  verification: "back to the Order Hub; both checks are asked again",
  accounts: "back to Accounts › Order approvals",
  production: "back to the MRP check",
  office: "back to where its lines were before the hold",
};

/** The reasons each desk offers. Codes are stored; the office's are the customer-tracking reasons. */
export const INTAKE_HOLD_REASONS = ["Quantity to confirm", "Product to confirm", "Rate to confirm", "Customer to call back", "Possible duplicate", "Other"] as const;
export const ACCOUNTS_HOLD_REASONS = [
  { code: "over_credit_limit", label: "Over credit limit" },
  { code: "overdue_bills", label: "Bills past credit days" },
  { code: "payment_pending", label: "Waiting for payment" },
  { code: "customer_requested", label: "Customer asked" },
  { code: "other", label: "Other" },
] as const;
export const PRODUCTION_HOLD_REASONS = [
  { code: "material_shortage", label: "Raw material short" },
  { code: "packing_shortage", label: "Packing material short" },
  { code: "capacity", label: "No capacity" },
  { code: "quality_check", label: "Quality check" },
  { code: "other", label: "Other" },
] as const;

/** A reason the customer may read, for each desk's codes — never the staff remark. */
export const HOLD_CUSTOMER_TEXT: Record<string, string> = {
  over_credit_limit: "Your order is waiting for a payment to be confirmed. We will update you as soon as it moves.",
  overdue_bills: "Your order is waiting for a payment to be confirmed. We will update you as soon as it moves.",
  payment_pending: "Your order is temporarily on hold because payment confirmation is pending.",
  customer_requested: "Your order is on hold as you requested. Let us know when you would like us to continue.",
  material_shortage: "Your order is delayed because one or more required materials are currently unavailable. We will update you when preparation can continue.",
  packing_shortage: "Your order is delayed because one or more required materials are currently unavailable. We will update you when preparation can continue.",
  capacity: "Preparation of your order is taking longer than planned. We will update you when it is ready.",
  quality_check: "Your order is undergoing an additional quality check. We will update you as soon as it is cleared.",
  other: "Your order is temporarily on hold. We will update you as soon as it moves.",
};

/* ------------------------------------------------------------- duplicates */

/**
 * A DUPLICATE is the same order punched twice, which happens because an order
 * shared on a WhatsApp group is punched by more than one person. It is decided
 * by rules alone: the same day, the same billing party AND the same delivery
 * party, and exactly the same items (product and cans, in any order). A
 * different delivery party is a different order even for one billing party —
 * a distributor ordering for two shops.
 */
export type DupShape = { key: string; billingId: string; deliveryId?: string | null; date: string; lines: { skuId: string; qtyCans: number }[] };

/** The items as one comparable string: product and cans, order ignored. */
export function itemsSignature(lines: DupShape["lines"]): string {
  return lines
    .map((l) => `${l.skuId}:${l.qtyCans}`)
    .sort()
    .join("|");
}

/** True where two orders are the same order by the rule above. */
export function sameOrder(a: DupShape, b: DupShape): boolean {
  return (
    a.key !== b.key &&
    a.billingId === b.billingId &&
    (a.deliveryId || a.billingId) === (b.deliveryId || b.billingId) &&
    a.date === b.date &&
    a.lines.length > 0 &&
    itemsSignature(a.lines) === itemsSignature(b.lines)
  );
}

/** Another TO or order for the same parties on the same day with exactly the same goods. */
export function duplicateOf(me: DupShape, others: DupShape[]): string | null {
  return others.find((o) => sameOrder(me, o))?.key ?? null;
}

/** "2 h 40 m apart" — the gap between the two punches, for the warning. */
export function gapWords(aMs: number, bMs: number): string {
  const min = Math.round(Math.abs(aMs - bMs) / 60_000);
  if (min < 1) return "punched within the same minute";
  if (min < 60) return `${min} m apart`;
  const h = Math.floor(min / 60);
  return `${h} h${min % 60 ? ` ${min % 60} m` : ""} apart`;
}

/** The comparison line the rules write, used where no model can. */
export function duplicateLine(gapMs: number | null): string {
  return `Same items, same parties${gapMs == null ? "" : `, ${gapWords(0, gapMs)}`}`;
}

/** What the person punching chose. `different` must carry a reason. */
export type DuplicateDecision = { decision: "different"; ofId: string; reason: string };

/** Why a decision cannot stand, or null. */
export function decisionRefusal(d: DuplicateDecision | null | undefined, foundIds: string[]): string | null {
  if (!d) return null;
  if (!d.reason?.trim()) return "Say why it is a different order";
  if (d.reason.trim().length > 300) return "Keep the reason under 300 characters";
  if (!foundIds.includes(d.ofId)) return "The order it looked like has changed. Check again";
  return null;
}
