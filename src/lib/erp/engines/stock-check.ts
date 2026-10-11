/* ---------------------------------------------------------------------------
 * INVENTORY ACCURACY CONTROL, as rules (PURE, client-safe).
 *
 *   Purchase requirement → BLIND physical count → compare with the reconciled
 *   book → match: continue · difference: red flag → independent recount →
 *   pending transactions reviewed → causes suggested → a person resolves →
 *   an approved adjustment, with its reason → the purchase continues.
 *
 * Nothing here reads or writes: the service hands in figures and gets
 * verdicts back, so the screen, the dashboard and the gate on the purchase
 * flow read one answer. Never silently adjust stock — no function here
 * produces a stock movement; the most it does is say one is needed.
 * ------------------------------------------------------------------------- */

export type CountKind = "reorder" | "cycle" | "recount" | "event" | "full";
export type CountStatus = "open" | "matched" | "flagged" | "recount" | "investigating" | "resolved" | "cancelled";
export type Resolution = "book_confirmed" | "missing_entry" | "adjusted" | "cancelled";
export type AbcClass = "A" | "B" | "C";

export const COUNT_KIND_LABEL: Record<CountKind, string> = {
  reorder: "Before purchase",
  cycle: "Cycle count",
  recount: "Independent recount",
  event: "Event recount",
  full: "Full count",
};

export const COUNT_STATUS_LABEL: Record<CountStatus, string> = {
  open: "To count",
  matched: "Matched",
  flagged: "Red flag",
  recount: "Recount out",
  investigating: "Investigating",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

export const RESOLUTION_LABEL: Record<Resolution, string> = {
  book_confirmed: "Book was right — the count was wrong",
  missing_entry: "A missing entry was recorded",
  adjusted: "Stock adjusted, approved",
  cancelled: "Count cancelled",
};

export const ADJUSTMENT_REASONS: { v: string; label: string }[] = [
  { v: "damage", label: "Damaged" },
  { v: "spillage", label: "Spillage or leakage" },
  { v: "evaporation", label: "Evaporation" },
  { v: "theft", label: "Theft or loss" },
  { v: "unrecorded_issue", label: "Issued, never recorded" },
  { v: "unrecorded_receipt", label: "Received, never recorded" },
  { v: "measurement", label: "Measuring or weighing difference" },
  { v: "other", label: "Other" },
];

export function adjustmentReasonLabel(v: string | null | undefined): string {
  return ADJUSTMENT_REASONS.find((r) => r.v === v)?.label ?? (v ?? "—");
}

export function adjustmentReasonByLabel(label: string | null | undefined): string | null {
  return ADJUSTMENT_REASONS.find((r) => r.label === label || r.v === label)?.v ?? null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/* ------------------------------------------------------------ the verdict */

/**
 * How far a count may sit from the book and still match. A percentage of the
 * book, never below a floor — a percentage of nothing is nothing, and an item
 * whose book is zero would otherwise flag on a single can.
 */
export function toleranceFor(book: number, percent: number, floor: number): number {
  return r3(Math.max(Math.abs(book) * (Math.max(percent, 0) / 100), Math.max(floor, 0)));
}

export type CountJudgement = {
  /** The book the count is held against: ledger stock + goods that arrived and are not in it yet − stock that left and is not out of it yet. */
  reconciled: number;
  /** Counted − reconciled: above zero is more on the shelf than the book. */
  difference: number;
  tolerance: number;
  verdict: "matched" | "flagged";
  direction: "exact" | "surplus" | "short";
};

/**
 * One count against the reconciled book. Pending movements are what make the
 * comparison fair: a drum standing at the gate waiting for its test is on the
 * shelf and not yet in the ledger, and flagging it would send somebody hunting
 * for a discrepancy that is only paperwork in progress.
 */
export function judgeCount(p: { counted: number; book: number; pendingIn: number; pendingOut: number; tolerancePercent: number; toleranceFloor: number }): CountJudgement {
  const reconciled = r3(p.book + p.pendingIn - p.pendingOut);
  const difference = r3(p.counted - reconciled);
  const tolerance = toleranceFor(reconciled, p.tolerancePercent, p.toleranceFloor);
  return {
    reconciled,
    difference,
    tolerance,
    verdict: Math.abs(difference) <= tolerance ? "matched" : "flagged",
    direction: difference === 0 ? "exact" : difference > 0 ? "surplus" : "short",
  };
}

/**
 * What an INDEPENDENT recount says about the first count. A second person
 * landing on the book means the first count was wrong; landing on the first
 * count means the difference is real; landing on neither means nobody can yet
 * say what is on the shelf, and it is counted again.
 */
export function recountOutcome(p: { first: number; second: number; reconciled: number; tolerance: number }): "book_confirmed" | "discrepancy_confirmed" | "inconsistent" {
  if (Math.abs(p.second - p.reconciled) <= p.tolerance) return "book_confirmed";
  if (Math.abs(p.second - p.first) <= p.tolerance) return "discrepancy_confirmed";
  return "inconsistent";
}

/* ------------------------------------------------------- ABC and cycles */

/**
 * ABC by the value that moved through each item: the items making up the
 * first `aCut`% of the value (running total, the item included) are A, up to
 * `bCut`% are B, the rest C. An item
 * that moved nothing is C whatever the cut says.
 */
export function abcClasses(items: { key: string; value: number }[], aCut = 80, bCut = 95): Map<string, AbcClass> {
  const out = new Map<string, AbcClass>();
  const total = items.reduce((t, i) => t + Math.max(i.value, 0), 0);
  const sorted = [...items].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  let running = 0;
  for (const i of sorted) {
    if (total <= 0 || i.value <= 0) {
      out.set(i.key, "C");
      continue;
    }
    const first = running === 0;
    running += i.value;
    const share = (running / total) * 100;
    /* By the running share INCLUDING the item; the single biggest item is A whatever its share. */
    out.set(i.key, first || share <= aCut ? "A" : share <= bCut ? "B" : "C");
  }
  return out;
}

/** Whole days from `from` to `to`, both yyyy-mm-dd. */
export function daysBetween(from: string, to: string): number {
  const d = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((d(to) - d(from)) / 86_400_000);
}

export type CycleCandidate = {
  key: string;
  abc: AbcClass;
  /** The last day it was counted, any kind of count. */
  lastCounted: string | null;
  /** Movements (receipts and issues) over the look-back. */
  movements: number;
  /** Flagged counts over the look-back. */
  discrepancies: number;
  /** An open count already stands for it. */
  hasOpenCount: boolean;
};

export type CycleDays = Record<AbcClass, number>;

/**
 * How often an item is counted: its class's cycle, halved while it has a
 * recent discrepancy — the shelf that was wrong last time is the one to look
 * at again soonest.
 */
export function cycleDaysFor(c: Pick<CycleCandidate, "abc" | "discrepancies">, days: CycleDays): number {
  const base = Math.max(1, days[c.abc]);
  return c.discrepancies > 0 ? Math.max(1, Math.round(base / 2)) : base;
}

export type CyclePick = { key: string; abc: AbcClass; score: number; reason: string };

/**
 * Today's cycle counts: every item past its cycle, ranked by how overdue, its
 * class, how much it moves and how often it has been wrong, capped at what one
 * day's counting can take. An item already waiting on a count is skipped.
 */
export function pickCycleCounts(cands: CycleCandidate[], today: string, days: CycleDays, limit: number): CyclePick[] {
  const weight: Record<AbcClass, number> = { A: 3, B: 2, C: 1 };
  const out: CyclePick[] = [];
  for (const c of cands) {
    if (c.hasOpenCount) continue;
    const cycle = cycleDaysFor(c, days);
    const since = c.lastCounted ? daysBetween(c.lastCounted, today) : null;
    if (since != null && since < cycle) continue;
    const overdue = since == null ? cycle : since - cycle;
    const score = overdue / cycle + weight[c.abc] + Math.min(c.movements, 30) / 10 + c.discrepancies * 2;
    const why = [
      since == null ? "never counted" : `last counted ${since} day${since === 1 ? "" : "s"} ago`,
      `class ${c.abc}, every ${cycle} days`,
      c.movements ? `${c.movements} movement${c.movements === 1 ? "" : "s"} lately` : null,
      c.discrepancies ? `${c.discrepancies} recent discrepanc${c.discrepancies === 1 ? "y" : "ies"}` : null,
    ].filter(Boolean);
    out.push({ key: c.key, abc: c.abc, score: Math.round(score * 100) / 100, reason: why.join(" · ") });
  }
  out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return out.slice(0, Math.max(0, limit));
}

/* ------------------------------------------------- the reorder quantity */

export type Justification = {
  /** What the shelf justifies buying: up to the maximum level. Null where no level is set. */
  justified: number | null;
  /** Requested above what the count justifies by more than the allowance. */
  unexpected: boolean;
  sentence: string;
};

/**
 * EVEN A MATCHING COUNT DOES NOT JUSTIFY ANY QUANTITY. The shelf says what is
 * there; the level says what should be; the difference is what a purchase is
 * for. Asking for well over it — or for anything while the shelf is above its
 * maximum — needs somebody to confirm the quantity in words.
 */
export function reorderJustification(p: { requested: number; onShelf: number; min: number | null; max: number | null; allowancePercent: number }): Justification {
  if (p.max == null) {
    return { justified: null, unexpected: false, sentence: "No re-order level is set for this item at this godown, so the count cannot say what quantity is justified." };
  }
  const justified = r3(Math.max(0, p.max - p.onShelf));
  const ceiling = justified * (1 + Math.max(p.allowancePercent, 0) / 100);
  const unexpected = p.requested > ceiling + 1e-9;
  const sentence =
    justified === 0
      ? `The shelf holds ${r3(p.onShelf)} against a maximum of ${p.max}: nothing needs buying to reach it.`
      : `The shelf holds ${r3(p.onShelf)}; buying ${justified} brings it to the maximum of ${p.max}.`;
  return { justified, unexpected, sentence };
}

/* ------------------------------------------------------ possible causes */

/**
 * A fact the service found that could explain a difference — every one a
 * record that exists, so a cause can always name what it is about.
 */
export type CauseFact = {
  kind:
    | "unrouted_inward"
    | "under_test"
    | "unposted_purchase"
    | "transfer_unreceived"
    | "recent_receipt"
    | "recent_issue"
    | "incomplete_packing";
  qty: number;
  /** What the record is, in a person's words ("PR 412 · 4 drums at the gate since 3 Oct"). */
  label: string;
  /** The screen and records the cause opens. */
  screen: string;
  ids: string[];
};

export type Cause = {
  title: string;
  detail: string;
  /** Whether what is missing is a RECORD of a movement or the goods themselves. */
  missing: "transaction" | "physical";
  likelihood: "likely" | "possible";
  qty: number | null;
  screen: string | null;
  ids: string[];
};

const SURPLUS_KINDS: Record<string, string> = {
  unrouted_inward: "Goods at the gate, not sent to testing or the register",
  under_test: "Goods under test, not yet in stock",
  unposted_purchase: "In the purchase register, not posted to stock",
  transfer_unreceived: "A transfer in that never reached this godown's book",
};

const SHORT_KINDS: Record<string, string> = {
  recent_receipt: "A receipt recorded for more than arrived",
  recent_issue: "An issue recorded, and more drawn than recorded",
  incomplete_packing: "Packing started, boxes or cans drawn before the batch was recorded",
};

/**
 * The causes worth checking for one difference, most likely first. A record
 * whose quantity accounts for the difference is "likely"; any record of the
 * right kind is "possible". A shortage nothing explains is a missing PHYSICAL
 * item, and it is said so — never filled in with a guessed record. These are
 * SUGGESTIONS: nothing here creates an entry.
 */
export function causeCandidates(difference: number, tolerance: number, facts: CauseFact[]): Cause[] {
  if (Math.abs(difference) <= tolerance) return [];
  const kinds = difference > 0 ? SURPLUS_KINDS : SHORT_KINDS;
  const gap = Math.abs(difference);
  const out: Cause[] = facts
    .filter((f) => kinds[f.kind])
    .map((f) => {
      const accounts = Math.abs(Math.abs(f.qty) - gap) <= Math.max(tolerance, gap * 0.05);
      return {
        title: kinds[f.kind],
        detail: f.label,
        missing: "transaction" as const,
        likelihood: accounts ? ("likely" as const) : ("possible" as const),
        qty: f.qty,
        screen: f.screen,
        ids: f.ids,
      };
    });
  /* Several small records can add up to the gap between them. */
  const possible = out.filter((c) => c.likelihood === "possible");
  if (possible.length > 1) {
    const sum = possible.reduce((t, c) => t + Math.abs(c.qty ?? 0), 0);
    if (Math.abs(sum - gap) <= Math.max(tolerance, gap * 0.05)) for (const c of possible) c.likelihood = "likely";
  }
  if (difference < 0) {
    out.push({
      title: "Goods missing from the shelf",
      detail: "If no record explains the shortage, the goods themselves are gone — spilled, damaged, evaporated or taken. That is an adjustment for approval, with its reason.",
      missing: "physical",
      likelihood: out.some((c) => c.likelihood === "likely") ? "possible" : "likely",
      qty: r3(difference),
      screen: null,
      ids: [],
    });
  } else {
    out.push({
      title: "Received and never recorded",
      detail: "If no record explains the surplus, goods came in without an inward entry. Find the delivery and record it against its PO; adjust only if it cannot be traced.",
      missing: "transaction",
      likelihood: out.some((c) => c.likelihood === "likely") ? "possible" : "likely",
      qty: r3(difference),
      screen: "inward",
      ids: [],
    });
  }
  const rank = (c: Cause) => (c.likelihood === "likely" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || Math.abs(Math.abs(a.qty ?? 0) - gap) - Math.abs(Math.abs(b.qty ?? 0) - gap));
}

/* ------------------------------------------- the gate on the purchase */

export type GateState = "not_required" | "to_count" | "flagged" | "clear" | "excepted" | "exception_requested" | "confirm_qty";

export type StockGate = { state: GateState; blocks: boolean; stage: string | null; next: string | null };

/**
 * Where a requirement stands with its stock check, and whether that holds the
 * purchase. The count must match, or its difference be resolved — or an
 * authorised person must have approved buying anyway (the urgent exception).
 * A quantity the count does not justify is confirmed before it is bought.
 */
export function stockGate(p: {
  required: boolean;
  /** The status of the newest count raised for it; null when none exists. */
  countStatus: CountStatus | null;
  exception: "requested" | "approved" | "rejected" | null;
  unexpectedQty: boolean;
  qtyConfirmed: boolean;
}): StockGate {
  if (!p.required) return { state: "not_required", blocks: false, stage: null, next: null };
  if (p.exception === "approved") return { state: "excepted", blocks: false, stage: null, next: null };
  const clear = p.countStatus === "matched" || p.countStatus === "resolved";
  if (!clear) {
    if (p.exception === "requested")
      return { state: "exception_requested", blocks: true, stage: "Exception requested", next: "An authorised person approves the urgent purchase, or the stock is counted." };
    if (p.countStatus === "flagged" || p.countStatus === "recount" || p.countStatus === "investigating")
      return { state: "flagged", blocks: true, stage: "Stock discrepancy", next: "The count differs from the book. Recount, find the cause and resolve it before buying." };
    return { state: "to_count", blocks: true, stage: "Count stock", next: "Count what is on the shelf. The book quantity is not shown until the count is in." };
  }
  if (p.unexpectedQty && !p.qtyConfirmed)
    return { state: "confirm_qty", blocks: true, stage: "Confirm quantity", next: "The quantity asked for is more than the count justifies. Confirm it, with why." };
  return { state: "clear", blocks: false, stage: null, next: null };
}

/**
 * The status a requirement's gate reads: its newest ROOT count — a recount is
 * a child of the count it checks, and the root carries where the check has
 * got to. Cancelled counts stand only when nothing else does.
 */
export function gateCountStatus(roots: { status: CountStatus; createdAt: Date }[]): CountStatus | null {
  if (!roots.length) return null;
  const live = roots.filter((c) => c.status !== "cancelled");
  const pool = live.length ? live : roots;
  return [...pool].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0].status;
}

/** The steps of the control, as drawn on the dashboard and in a count's drawer. */
export const CONTROL_STEPS = ["Count", "Compare", "Recount", "Investigate", "Resolve", "Purchase continues"] as const;

/** Which of CONTROL_STEPS a ROOT count has reached (−1: cancelled). */
export function controlStep(status: CountStatus, adjustmentPending = false): number {
  switch (status) {
    case "open":
      return 0;
    case "flagged":
    case "recount":
      return 2;
    case "investigating":
      return adjustmentPending ? 4 : 3;
    case "matched":
    case "resolved":
      return 5;
    case "cancelled":
      return -1;
  }
}
