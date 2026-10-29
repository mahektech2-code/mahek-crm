/* ---------------------------------------------------------------------------
 * A CHANGE TO A PRICE BOOK — what moved, whether it is safe, who may approve.
 *
 * Pure: every rule a change is judged by, with no database and no clock. The
 * service reads the base revision, the draft, the neighbouring books and the
 * last months' volumes and hands them here; the screen draws what comes back
 * and the actions refuse on the same answers, so the step bar and the server
 * cannot disagree about whether a change may be sent or approved.
 *
 * THE SHAPE OF THE WORKFLOW. A change is edits on a draft copy of the book's
 * newest revision. It is CHECKED (rules here, optional AI reviewers beside),
 * SUBMITTED by its maker, APPROVED by somebody else, and published on its
 * go-live date — until which the base revision goes on pricing. A check is
 * tied to the exact rates it read (`ratesHash`): editing after a check makes
 * it stale and the change has to be checked again before it can be sent.
 * ------------------------------------------------------------------------- */

import { inclFromEx } from "@/lib/engines/price-math";

const BP = 10_000;

/** One rate row as a change reads it — a base revision's or the draft's. */
export type ChangeRate = {
  productId: string;
  productName: string;
  /** Brand line / family, for the per-litre ladder. */
  family: string;
  millilitresPerCan: number | null;
  minCans: number | null;
  rateExGstPaise: number;
  rateInclGstPaise: number;
  offered: boolean;
};

export type CellKind = "same" | "up" | "down" | "added" | "removed" | "offer_changed";

export type CellDiff = {
  key: string;
  productId: string;
  productName: string;
  family: string;
  millilitresPerCan: number | null;
  minCans: number | null;
  before: ChangeRate | null;
  after: ChangeRate | null;
  kind: CellKind;
  /** Change of the ex-GST rate, in basis points of the old one. Null where either side is missing. */
  changeBp: number | null;
};

/** The identity of one priced cell: a product, at a slab. */
export function cellKey(productId: string, minCans: number | null): string {
  return `${productId}|${minCans ?? 0}`;
}

/** Every cell of the base against the draft. Unchanged cells are included as `same`. */
export function diffRates(base: readonly ChangeRate[], draft: readonly ChangeRate[]): CellDiff[] {
  const b = new Map(base.map((r) => [cellKey(r.productId, r.minCans), r]));
  const d = new Map(draft.map((r) => [cellKey(r.productId, r.minCans), r]));
  const keys = [...new Set([...b.keys(), ...d.keys()])];
  const out: CellDiff[] = [];
  for (const key of keys) {
    const before = b.get(key) ?? null;
    const after = d.get(key) ?? null;
    const any = (after ?? before)!;
    let kind: CellKind;
    if (!before) kind = "added";
    else if (!after) kind = "removed";
    else if (before.offered !== after.offered) kind = "offer_changed";
    else if (after.rateExGstPaise > before.rateExGstPaise) kind = "up";
    else if (after.rateExGstPaise < before.rateExGstPaise) kind = "down";
    else kind = "same";
    const changeBp =
      before && after && before.rateExGstPaise > 0
        ? Math.round(((after.rateExGstPaise - before.rateExGstPaise) * BP) / before.rateExGstPaise)
        : null;
    out.push({
      key,
      productId: any.productId,
      productName: any.productName,
      family: any.family,
      millilitresPerCan: any.millilitresPerCan,
      minCans: any.minCans,
      before,
      after,
      kind,
      changeBp,
    });
  }
  return out.sort(
    (x, y) =>
      x.family.localeCompare(y.family) ||
      (x.millilitresPerCan ?? 0) - (y.millilitresPerCan ?? 0) ||
      x.productName.localeCompare(y.productName) ||
      (x.minCans ?? 0) - (y.minCans ?? 0),
  );
}

/** The changed cells only — what a reviewer has to read. */
export function changedCells(diffs: readonly CellDiff[]): CellDiff[] {
  return diffs.filter((d) => d.kind !== "same");
}

export type ChangeCounts = {
  changed: number;
  up: number;
  down: number;
  added: number;
  removed: number;
  offerChanged: number;
  /** Mean move of the cells that went up or down, in basis points (signed). Null with none. */
  averageBp: number | null;
  /** The largest move by size, signed. */
  largestBp: number | null;
};

export function countChanges(diffs: readonly CellDiff[]): ChangeCounts {
  const c: ChangeCounts = { changed: 0, up: 0, down: 0, added: 0, removed: 0, offerChanged: 0, averageBp: null, largestBp: null };
  const moves: number[] = [];
  for (const d of diffs) {
    if (d.kind === "same") continue;
    c.changed++;
    if (d.kind === "up") c.up++;
    if (d.kind === "down") c.down++;
    if (d.kind === "added") c.added++;
    if (d.kind === "removed") c.removed++;
    if (d.kind === "offer_changed") c.offerChanged++;
    if ((d.kind === "up" || d.kind === "down") && d.changeBp != null) moves.push(d.changeBp);
  }
  if (moves.length) {
    c.averageBp = Math.round(moves.reduce((a, b) => a + b, 0) / moves.length);
    c.largestBp = moves.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  }
  return c;
}

/* ---------------------------------------------------------- money effect */

export type EffectRow = {
  key: string;
  productId: string;
  productName: string;
  beforeExPaise: number | null;
  afterExPaise: number | null;
  /** Cans a month the book's shops bought of this product, averaged over the window. */
  cansPerMonth: number;
  /** (after − before) × cans a month. Positive is more money in. */
  effectPerMonthPaise: number;
};

/**
 * What the change is worth a month, at the volume the book's shops actually
 * bought. A removed product counts as nothing (the shop falls to a wider book,
 * whose price is not known here) and an added one as nothing (nobody bought it
 * at a price that did not exist) — both are flagged by the checks instead.
 */
export function revenueEffect(
  diffs: readonly CellDiff[],
  cansPerMonth: ReadonlyMap<string, number>,
): { rows: EffectRow[]; totalPerMonthPaise: number; dropPerMonthPaise: number } {
  const rows: EffectRow[] = [];
  let total = 0;
  let drop = 0;
  for (const d of diffs) {
    if (d.kind !== "up" && d.kind !== "down") continue;
    /* Volume is attributed to the base slab only: a slab's cans are already
       counted in the product's total, and counting them twice doubles it. */
    if ((d.minCans ?? 0) !== 0) continue;
    const cans = cansPerMonth.get(d.productId) ?? 0;
    const effect = Math.round((d.after!.rateExGstPaise - d.before!.rateExGstPaise) * cans);
    total += effect;
    if (effect < 0) drop += effect;
    rows.push({
      key: d.key,
      productId: d.productId,
      productName: d.productName,
      beforeExPaise: d.before?.rateExGstPaise ?? null,
      afterExPaise: d.after?.rateExGstPaise ?? null,
      cansPerMonth: cans,
      effectPerMonthPaise: effect,
    });
  }
  rows.sort((a, b) => Math.abs(b.effectPerMonthPaise) - Math.abs(a.effectPerMonthPaise) || a.productName.localeCompare(b.productName));
  return { rows, totalPerMonthPaise: total, dropPerMonthPaise: drop };
}

/* ---------------------------------------------------------------- checks */

export type FlagKind =
  | "zero_or_negative"
  | "removed_vs_live"
  | "gst_round_trip"
  | "ladder"
  | "date_past"
  | "date_before_base"
  | "big_move"
  | "typo_vs_books"
  | "override_conflict"
  | "no_change"
  | "readback";

export type ChangeFlag = {
  /** Stable for the same finding on the same cell, so an acknowledgement survives a re-check. */
  key: string;
  kind: FlagKind;
  severity: "high" | "medium" | "low";
  /** A blocking flag must be FIXED; anything else may be acknowledged with a note. */
  blocking: boolean;
  productId: string | null;
  cellKey: string | null;
  message: string;
  /** Who raised it: rules, or a named model. */
  by: "rules" | string;
};

/** The same product in another live book, for the typo check. */
export type NeighbourRate = { bookName: string; productId: string; rateExGstPaise: number };

/** A shop's override on this book, for the conflict check. */
export type OverrideOnBook = { customerName: string; productId: string; rateExGstPaise: number };

export type CheckInput = {
  base: readonly ChangeRate[];
  draft: readonly ChangeRate[];
  gstBp: number;
  /** Rates of a list generated by a rule show the rupee (see `listInclFromEx`). */
  derived: boolean;
  goLive: string | null;
  baseEffectiveFrom: string | null;
  today: string;
  neighbours: readonly NeighbourRate[];
  overrides: readonly OverrideOnBook[];
  /** A move larger than this, either way, is flagged. Basis points. */
  bigMoveBp: number;
  /** A cell this many times off the same product elsewhere is a likely typo. */
  typoFactor: number;
};

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pct = (bp: number) => `${(bp / 100).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;

/**
 * Every rule a change is checked by. Blocking flags stop it being sent; the
 * rest stop it until the maker fixes them or says they are intended.
 */
export function runChecks(input: CheckInput): ChangeFlag[] {
  const flags: ChangeFlag[] = [];
  const diffs = diffRates(input.base, input.draft);
  const push = (f: Omit<ChangeFlag, "by">) => flags.push({ ...f, by: "rules" });

  if (!changedCells(diffs).length) {
    push({
      key: "no_change",
      kind: "no_change",
      severity: "low",
      blocking: true,
      productId: null,
      cellKey: null,
      message: "Nothing has changed yet. Edit a price before checking.",
    });
  }

  for (const r of input.draft) {
    if (r.offered && r.rateExGstPaise <= 0) {
      push({
        key: `zero|${cellKey(r.productId, r.minCans)}`,
        kind: "zero_or_negative",
        severity: "high",
        blocking: true,
        productId: r.productId,
        cellKey: cellKey(r.productId, r.minCans),
        message: `${r.productName} is priced at ${rupees(r.rateExGstPaise)}. A product on sale needs a price above zero; mark it not offered instead.`,
      });
    }
    const expected = inclFromEx(r.rateExGstPaise, input.gstBp);
    // A derived list prints the rupee, so it is allowed to sit within a rupee.
    const tolerance = input.derived ? 100 : 1;
    if (r.offered && r.rateExGstPaise > 0 && Math.abs(expected - r.rateInclGstPaise) > tolerance) {
      push({
        key: `gst|${cellKey(r.productId, r.minCans)}`,
        kind: "gst_round_trip",
        severity: "medium",
        blocking: false,
        productId: r.productId,
        cellKey: cellKey(r.productId, r.minCans),
        message: `${r.productName}: ${rupees(r.rateInclGstPaise)} with GST does not match ${rupees(r.rateExGstPaise)} before GST at ${pct(input.gstBp)} (expected ${rupees(expected)}).`,
      });
    }
  }

  for (const d of diffs) {
    if (d.kind === "removed") {
      push({
        key: `removed|${d.key}`,
        kind: "removed_vs_live",
        severity: "medium",
        blocking: false,
        productId: d.productId,
        cellKey: d.key,
        message: `${d.productName}${d.minCans ? ` (from ${d.minCans} cans)` : ""} is on the live revision and not on this change. Its shops will fall to a wider book for it.`,
      });
    }
    if ((d.kind === "up" || d.kind === "down") && d.changeBp != null && Math.abs(d.changeBp) > input.bigMoveBp) {
      push({
        key: `big|${d.key}`,
        kind: "big_move",
        severity: Math.abs(d.changeBp) > input.bigMoveBp * 2 ? "high" : "medium",
        blocking: false,
        productId: d.productId,
        cellKey: d.key,
        message: `${d.productName} moves ${d.changeBp > 0 ? "up" : "down"} ${pct(Math.abs(d.changeBp))}, from ${rupees(d.before!.rateExGstPaise)} to ${rupees(d.after!.rateExGstPaise)} before GST.`,
      });
    }
  }

  flags.push(...ladderBreaks(input.draft).map((f) => ({ ...f, by: "rules" as const })));
  flags.push(...typoAgainst(input.draft, input.neighbours, input.typoFactor).map((f) => ({ ...f, by: "rules" as const })));

  const draftBy = new Map(input.draft.filter((r) => (r.minCans ?? 0) === 0).map((r) => [r.productId, r]));
  for (const o of input.overrides) {
    const r = draftBy.get(o.productId);
    if (r && r.offered && o.rateExGstPaise > r.rateExGstPaise) {
      push({
        key: `override|${o.productId}|${o.customerName}`,
        kind: "override_conflict",
        severity: "medium",
        blocking: false,
        productId: o.productId,
        cellKey: cellKey(o.productId, null),
        message: `${o.customerName}'s special price for ${r.productName} (${rupees(o.rateExGstPaise)}) would now be dearer than this book (${rupees(r.rateExGstPaise)}). The special price still wins for that shop.`,
      });
    }
  }

  const dateProblem = goLiveProblem(input.goLive, input.today, input.baseEffectiveFrom);
  if (dateProblem) {
    push({
      key: `date|${dateProblem.kind}`,
      kind: dateProblem.kind,
      severity: "high",
      blocking: true,
      productId: null,
      cellKey: null,
      message: dateProblem.message,
    });
  }

  return flags;
}

/** Why a go-live date cannot be used, or null. Shared by the check and the approval. */
export function goLiveProblem(
  goLive: string | null,
  today: string,
  baseEffectiveFrom: string | null,
): { kind: "date_past" | "date_before_base"; message: string } | null {
  if (!goLive) return null;
  if (goLive < today) return { kind: "date_past", message: `The go-live date ${goLive} has passed. Pick today or a later day.` };
  if (baseEffectiveFrom && goLive <= baseEffectiveFrom) {
    return {
      kind: "date_before_base",
      message: `The current revision only starts on ${baseEffectiveFrom}, so this change must go live after that.`,
    };
  }
  return null;
}

/**
 * A BIGGER PACK DEARER PER LITRE than a smaller one of the same family is
 * almost always a slip — a can priced as a drum, a digit dropped. Base slabs
 * only; a family read by its brand line.
 */
export function ladderBreaks(rates: readonly ChangeRate[]): Array<Omit<ChangeFlag, "by">> {
  const byFamily = new Map<string, ChangeRate[]>();
  for (const r of rates) {
    if ((r.minCans ?? 0) !== 0 || !r.offered || !r.millilitresPerCan || r.rateExGstPaise <= 0) continue;
    byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), r]);
  }
  const out: Array<Omit<ChangeFlag, "by">> = [];
  for (const [family, rows] of byFamily) {
    // One price per pack size: the cheapest per litre of that size stands for it.
    const bySize = new Map<number, { r: ChangeRate; perLitre: number }>();
    for (const r of rows) {
      const perLitre = (r.rateExGstPaise * 1000) / r.millilitresPerCan!;
      const cur = bySize.get(r.millilitresPerCan!);
      if (!cur || perLitre < cur.perLitre) bySize.set(r.millilitresPerCan!, { r, perLitre });
    }
    const sizes = [...bySize.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sizes.length; i++) {
      const small = sizes[i - 1][1];
      const big = sizes[i][1];
      // Half a percent of slack: rounding to the rupee moves small packs that much.
      if (big.perLitre > small.perLitre * 1.005) {
        out.push({
          key: `ladder|${big.r.productId}`,
          kind: "ladder",
          severity: "medium",
          blocking: false,
          productId: big.r.productId,
          cellKey: cellKey(big.r.productId, null),
          message: `${family}: ${big.r.productName} costs ${rupees(Math.round(big.perLitre))} a litre, more than the smaller ${small.r.productName} at ${rupees(Math.round(small.perLitre))} a litre.`,
        });
      }
    }
  }
  return out;
}

/** A cell far off the same product in every other live book — a typo more often than a price. */
export function typoAgainst(
  rates: readonly ChangeRate[],
  neighbours: readonly NeighbourRate[],
  factor: number,
): Array<Omit<ChangeFlag, "by">> {
  if (factor <= 1) return [];
  const byProduct = new Map<string, NeighbourRate[]>();
  for (const n of neighbours) byProduct.set(n.productId, [...(byProduct.get(n.productId) ?? []), n]);
  const out: Array<Omit<ChangeFlag, "by">> = [];
  for (const r of rates) {
    if ((r.minCans ?? 0) !== 0 || !r.offered || r.rateExGstPaise <= 0) continue;
    const others = (byProduct.get(r.productId) ?? []).map((n) => n.rateExGstPaise).filter((v) => v > 0);
    if (others.length < 1) continue;
    const median = medianOf(others);
    const ratio = r.rateExGstPaise / median;
    if (ratio >= factor || ratio <= 1 / factor) {
      const guess = suggestTypoFix(r.rateExGstPaise, median);
      out.push({
        key: `typo|${r.productId}`,
        kind: "typo_vs_books",
        severity: "high",
        blocking: false,
        productId: r.productId,
        cellKey: cellKey(r.productId, null),
        message: `${r.productName} at ${rupees(r.rateExGstPaise)} is ${ratio >= 1 ? `${ratio.toFixed(1)}× more than` : `${(1 / ratio).toFixed(1)}× less than`} other books (${rupees(Math.round(median))}).${guess ? ` Did you mean ${rupees(guess)}?` : ""}`,
      });
    }
  }
  return out;
}

function medianOf(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * A slipped digit: the figure times or divided by ten that lands nearest the
 * other books, where it lands within a quarter of them. Null otherwise — a
 * guess that is not close is not offered.
 */
export function suggestTypoFix(paise: number, typical: number): number | null {
  const tries = [paise * 10, paise / 10, paise * 100, paise / 100].map((v) => Math.round(v));
  let best: number | null = null;
  for (const t of tries) {
    if (Math.abs(t - typical) / typical > 0.25) continue;
    if (best == null || Math.abs(t - typical) < Math.abs(best - typical)) best = t;
  }
  return best;
}

/** The flags still standing in the way: blocking ones, and the rest nobody acknowledged. */
export function openFlags(flags: readonly ChangeFlag[], acks: Readonly<Record<string, unknown>>): ChangeFlag[] {
  return flags.filter((f) => f.blocking || !acks[f.key]);
}

/* ------------------------------------------------------ the rates' hash */

/**
 * A fingerprint of a draft's rates. Stored with a check, compared before a
 * change is sent or approved: what was checked must be what is approved.
 * Order-independent, and a plain string hash so it runs in a browser too.
 */
export function ratesHash(rates: readonly ChangeRate[]): string {
  const parts = rates
    .map((r) => `${cellKey(r.productId, r.minCans)}:${r.rateExGstPaise}:${r.rateInclGstPaise}:${r.offered ? 1 : 0}`)
    .sort();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x2c, 0x01000193) >>> 0;
  }
  return `${parts.length}-${h1.toString(16)}-${h2.toString(16)}`;
}

/* -------------------------------------------------------------- stages */

export type ChangeStage = "edit" | "check" | "approve" | "scheduled" | "live" | "sent_back" | "cancelled";

/**
 * Where a change is in Edit → Check → Approve → Live. `approved` splits on the
 * date: before its go-live it is scheduled and the base revision still prices.
 */
export function stageOf(
  change: { status: string; checkedHash: string | null; goLive: string | null },
  currentHash: string,
  today: string,
): ChangeStage {
  switch (change.status) {
    case "cancelled":
      return "cancelled";
    case "sent_back":
      return "sent_back";
    case "submitted":
      return "approve";
    case "approved":
      return change.goLive && change.goLive > today ? "scheduled" : "live";
    default:
      return change.checkedHash && change.checkedHash === currentHash ? "check" : "edit";
  }
}

export const STAGE_LABEL: Record<ChangeStage, string> = {
  edit: "Editing",
  check: "Checked",
  approve: "Waiting approval",
  scheduled: "Scheduled",
  live: "Live",
  sent_back: "Sent back",
  cancelled: "Cancelled",
};

/* ---------------------------------------------------- send and approve */

/** Why the maker cannot send this change for approval yet, or null. */
export function submitRefusal(input: {
  status: string;
  checkedHash: string | null;
  currentHash: string;
  flags: readonly ChangeFlag[];
  acks: Readonly<Record<string, unknown>>;
  goLive: string | null;
  reason: string | null;
}): string | null {
  if (input.status !== "draft" && input.status !== "sent_back") return `This change is ${input.status.replace("_", " ")}; only a change being edited can be sent.`;
  if (!input.checkedHash) return "Run the check first.";
  if (input.checkedHash !== input.currentHash) return "Prices changed after the last check. Check again before sending.";
  if (!input.goLive) return "Choose the day this change goes live.";
  if (!input.reason || !input.reason.trim()) return "Say why prices are changing. The approver reads it first.";
  const open = openFlags(input.flags, input.acks);
  const blocking = open.filter((f) => f.blocking);
  if (blocking.length) return `${blocking.length} problem${blocking.length === 1 ? " has" : "s have"} to be fixed: ${blocking[0].message}`;
  if (open.length) return `${open.length} flag${open.length === 1 ? " needs" : "s need"} a fix or a note saying it is intended.`;
  return null;
}

/** Whether a change needs a second approver: a large effect, or a deep cut. */
export function needsSecondApprover(input: {
  effectPerMonthPaise: number;
  dropPerMonthPaise: number;
  largestDropBp: number | null;
  aboveEffectPaise: number;
  dropPercent: number;
}): boolean {
  if (input.aboveEffectPaise > 0 && Math.abs(input.effectPerMonthPaise) >= input.aboveEffectPaise) return true;
  if (input.aboveEffectPaise > 0 && Math.abs(input.dropPerMonthPaise) >= input.aboveEffectPaise) return true;
  if (input.dropPercent > 0 && input.largestDropBp != null && input.largestDropBp < 0 && -input.largestDropBp > input.dropPercent * 100) return true;
  return false;
}

/** The deepest cut among the changed cells, in basis points (negative), or null. */
export function largestDrop(diffs: readonly CellDiff[]): number | null {
  let min: number | null = null;
  for (const d of diffs) if (d.kind === "down" && d.changeBp != null && (min == null || d.changeBp < min)) min = d.changeBp;
  return min;
}

/**
 * Why this person cannot approve this change now, or null. Maker-checker is
 * the point: whoever made the change does not approve it — unless the desk
 * has switched that off because one person runs it alone.
 */
export function approvalRefusal(input: {
  status: string;
  makerId: string;
  approverId: string | null;
  actorId: string;
  makerChecker: boolean;
  needsSecond: boolean;
  checkedHash: string | null;
  currentHash: string;
}): string | null {
  if (input.status !== "submitted") return `This change is ${input.status.replace("_", " ")}, not waiting for approval.`;
  if (input.checkedHash !== input.currentHash) return "The prices changed after they were checked. Send it back to be checked again.";
  if (input.makerChecker && input.actorId === input.makerId) return "You made this change, so somebody else approves it.";
  if (input.approverId && input.actorId === input.approverId) return "You have already approved this. A second approver is needed.";
  if (input.approverId && !input.needsSecond) return "This change is already approved.";
  return null;
}

/** After this approval, is the change fully approved? */
export function fullyApproved(input: { needsSecond: boolean; hadFirst: boolean }): boolean {
  return !input.needsSecond || input.hadFirst;
}
