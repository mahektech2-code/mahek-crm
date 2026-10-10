/* ---------------------------------------------------------------------------
 * Unusual-activity alerts (AI PRD §5), PURE. Every rule is ordinary code over
 * the records the ERP already holds, compared with each item's own history;
 * nothing here reads a model. Each candidate names the records behind it and
 * says in one sentence what is unusual, in figures somebody can check.
 *
 * `subject` is the condition's identity: an open alert with the same kind and
 * subject is the same alert, so a rule that fires every hour raises it once.
 * ------------------------------------------------------------------------- */

import { daysBetween } from "./sales";

export type AlertKind =
  | "rateJump"
  | "rateMissing"
  | "sfgLoss"
  | "fillLoss"
  | "writeOffs"
  | "thinMargin"
  | "slowFulfil"
  | "readyUnbilled"
  | "testStuck"
  | "lrMissing"
  | "cnNotIssued"
  | "packStuck"
  | "duplicateExpense"
  | "cashNegative"
  | "belowLevel";

export const ALERT_LABEL: Record<AlertKind, string> = {
  rateJump: "Purchase rate jump",
  rateMissing: "Rate missing too long",
  sfgLoss: "High SFG loss",
  fillLoss: "High filling loss",
  writeOffs: "Repeated write-offs",
  thinMargin: "Negative or thin margin",
  slowFulfil: "Slow fulfilment",
  readyUnbilled: "Ready but not billed",
  testStuck: "Test unverified",
  lrMissing: "LR missing",
  cnNotIssued: "Credit note not issued",
  packStuck: "Packing batch incomplete",
  duplicateExpense: "Duplicate-looking expense",
  cashNegative: "Petty cash below zero",
  belowLevel: "Stock below re-order level",
};

export type Candidate = {
  kind: AlertKind;
  subject: string;
  screen: string;
  recordIds: string[];
  /** The power a viewer needs, where the alert shows money or cost. */
  power?: "viewPurchaseMoney" | "viewCost" | "lostStock";
  values: Record<string, unknown>;
  explanation: string;
};

export type Thresholds = {
  rateJumpPct: number;
  rateLookback: number;
  rateMissingDays: number;
  sfgLossPct: number;
  fillLossPct: number;
  writeOffCount: number;
  writeOffDays: number;
  marginPct: number;
  fulfilDays: number;
  readyUnbilledHours: number;
  stuckTestHours: number;
  stuckLrDays: number;
  stuckCnDays: number;
  stuckPackDays: number;
  duplicateExpenseDays: number;
};

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pct = (v: number) => `${Math.round(v * 10) / 10}%`;
const hoursSince = (at: Date, now: Date) => (now.getTime() - at.getTime()) / 3600000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ================================================================ purchase */

export type PurchaseFact = { id: string; item: string; itemId: string; supplier: string; supplierId: string; date: string; createdAt: Date; litreRatePaise: number | null };

/** A litre rate far from the median of the same supplier's recent rates for the item. */
export function rateJumps(purchases: PurchaseFact[], t: Thresholds): Candidate[] {
  const out: Candidate[] = [];
  const by = new Map<string, PurchaseFact[]>();
  for (const p of purchases) if (p.litreRatePaise != null && p.litreRatePaise > 0) by.set(`${p.itemId}|${p.supplierId}`, [...(by.get(`${p.itemId}|${p.supplierId}`) ?? []), p]);
  for (const list of by.values()) {
    list.sort((a, b) => (a.date === b.date ? a.createdAt.getTime() - b.createdAt.getTime() : a.date < b.date ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      const prev = list.slice(Math.max(0, i - t.rateLookback), i).map((p) => p.litreRatePaise!);
      const med = median(prev);
      const cur = list[i].litreRatePaise!;
      const diff = ((cur - med) / med) * 100;
      if (Math.abs(diff) > t.rateJumpPct)
        out.push({
          kind: "rateJump",
          subject: list[i].id,
          screen: "register",
          recordIds: [list[i].id],
          power: "viewPurchaseMoney",
          values: { rate: cur, median: med, diffPct: Math.round(diff * 10) / 10, compared: prev.length },
          explanation: `${list[i].item} from ${list[i].supplier} at ${rupees(cur)}/Ltr is ${pct(Math.abs(diff))} ${diff > 0 ? "above" : "below"} the median ${rupees(med)} of its last ${prev.length} purchase${prev.length === 1 ? "" : "s"}.`,
        });
    }
  }
  return out;
}

export function ratesMissing(rows: { id: string; item: string; lot: string; date: string; ratePaise: number | null }[], today: string, t: Thresholds): Candidate[] {
  return rows
    .filter((r) => (r.ratePaise == null || r.ratePaise <= 0) && daysBetween(r.date, today) > t.rateMissingDays)
    .map((r) => ({
      kind: "rateMissing" as const,
      subject: r.id,
      screen: "register",
      recordIds: [r.id],
      values: { days: daysBetween(r.date, today) },
      explanation: `Lot ${r.lot} (${r.item}) has had no rate for ${daysBetween(r.date, today)} days, so it is not in stock.`,
    }));
}

/* ============================================================== production */

export function sfgLosses(lines: { id: string; sfgNo: number; product: string; totalUse: number; adjusted: number }[], t: Thresholds): Candidate[] {
  return lines
    .filter((l) => l.totalUse > 0 && (l.adjusted / l.totalUse) * 100 > t.sfgLossPct)
    .map((l) => ({
      kind: "sfgLoss" as const,
      subject: l.id,
      screen: "sfgBatches",
      recordIds: [l.id],
      values: { lossPct: Math.round((l.adjusted / l.totalUse) * 1000) / 10 },
      explanation: `SFG ${l.sfgNo} (${l.product}) lost ${l.adjusted} Ltr of ${l.totalUse} — ${pct((l.adjusted / l.totalUse) * 100)}, above ${t.sfgLossPct}%.`,
    }));
}

export function fillLosses(fills: { id: string; lot: string; product: string; cans: number; adjusted: number }[], t: Thresholds): Candidate[] {
  return fills
    .filter((f) => f.cans > 0 && (f.adjusted / f.cans) * 100 > t.fillLossPct)
    .map((f) => ({
      kind: "fillLoss" as const,
      subject: f.id,
      screen: "fgFill",
      recordIds: [f.id],
      values: { lossPct: Math.round((f.adjusted / f.cans) * 1000) / 10 },
      explanation: `Filling ${f.lot} (${f.product}) lost ${f.adjusted} of ${f.cans} cans — ${pct((f.adjusted / f.cans) * 100)}, above ${t.fillLossPct}%.`,
    }));
}

/** Write-offs by one person, or from one godown, piling up inside the window. */
export function writeOffs(transfers: { id: string; date: string; by: string; fromGodown: string }[], today: string, t: Thresholds): Candidate[] {
  const recent = transfers.filter((x) => daysBetween(x.date, today) <= t.writeOffDays);
  const out: Candidate[] = [];
  const group = (key: (x: (typeof recent)[number]) => string, what: string) => {
    const by = new Map<string, typeof recent>();
    for (const x of recent) by.set(key(x), [...(by.get(key(x)) ?? []), x]);
    for (const [k, xs] of by)
      if (xs.length >= t.writeOffCount)
        out.push({
          kind: "writeOffs",
          subject: `${what}:${k}`,
          screen: "transfers",
          recordIds: xs.map((x) => x.id),
          power: "lostStock",
          values: { count: xs.length },
          explanation: `${xs.length} write-offs to Item Lost Record ${what === "by" ? `by ${k}` : `from ${k}`} in the last ${t.writeOffDays} days.`,
        });
  };
  group((x) => x.by, "by");
  group((x) => x.fromGodown, "from");
  return out;
}

export function packsStuck(batches: { batchNo: string; ids: string[]; date: string; remaining: number }[], today: string, t: Thresholds): Candidate[] {
  return batches
    .filter((b) => b.remaining !== 0 && daysBetween(b.date, today) > t.stuckPackDays)
    .map((b) => ({
      kind: "packStuck" as const,
      subject: b.batchNo,
      screen: "packBatches",
      recordIds: b.ids,
      values: { remaining: b.remaining },
      explanation: `Packing batch ${b.batchNo} has been incomplete for ${daysBetween(b.date, today)} days — ${Math.abs(b.remaining)} cans ${b.remaining > 0 ? "still to draw" : "over"}, so its boxes are not in stock.`,
    }));
}

export function testsStuck(tests: { id: string; pr: number; item: string; createdAt: Date; decided: boolean }[], now: Date, t: Thresholds): Candidate[] {
  return tests
    .filter((x) => !x.decided && hoursSince(x.createdAt, now) > t.stuckTestHours)
    .map((x) => ({
      kind: "testStuck" as const,
      subject: x.id,
      screen: "testing",
      recordIds: [x.id],
      values: { hours: Math.round(hoursSince(x.createdAt, now)) },
      explanation: `The test for PR ${x.pr} (${x.item}) has waited ${Math.round(hoursSince(x.createdAt, now))} hours for the verifier.`,
    }));
}

/* =================================================================== sales */

export type DetailFact = {
  id: string;
  orderNo: number;
  party: string;
  orderDate: string;
  dispatchDate: string | null;
  amountPaise: number | null;
  marginPaise: number | null;
};

export function thinMargins(details: DetailFact[], t: Thresholds): Candidate[] {
  return details
    .filter((d) => d.dispatchDate && d.marginPaise != null && d.amountPaise && (d.marginPaise < 0 || (d.marginPaise / d.amountPaise) * 100 < t.marginPct))
    .map((d) => ({
      kind: "thinMargin" as const,
      subject: d.id,
      screen: "orderDetails",
      recordIds: [d.id],
      power: "viewCost" as const,
      values: { margin: d.marginPaise, marginPct: Math.round(((d.marginPaise ?? 0) / (d.amountPaise ?? 1)) * 1000) / 10 },
      explanation: `Order ${d.orderNo} for ${d.party} ${d.marginPaise! < 0 ? `lost ${rupees(-d.marginPaise!)}` : `made ${pct((d.marginPaise! / d.amountPaise!) * 100)} margin, below ${t.marginPct}%`}.`,
    }));
}

export function slowFulfilment(details: DetailFact[], t: Thresholds): Candidate[] {
  return details
    .filter((d) => d.dispatchDate && daysBetween(d.orderDate, d.dispatchDate) > t.fulfilDays)
    .map((d) => ({
      kind: "slowFulfil" as const,
      subject: d.id,
      screen: "orderDetails",
      recordIds: [d.id],
      values: { days: daysBetween(d.orderDate, d.dispatchDate!) },
      explanation: `Order ${d.orderNo} for ${d.party} took ${daysBetween(d.orderDate, d.dispatchDate!)} days to dispatch, against ${t.fulfilDays}.`,
    }));
}

export function readyUnbilled(lines: { id: string; orderNo: number; party: string; readySince: Date; allocatedInFull: boolean; billed: boolean; ready: boolean }[], now: Date, t: Thresholds): Candidate[] {
  return lines
    .filter((l) => l.ready && l.allocatedInFull && !l.billed && hoursSince(l.readySince, now) > t.readyUnbilledHours)
    .map((l) => ({
      kind: "readyUnbilled" as const,
      subject: l.id,
      screen: "orders",
      recordIds: [l.id],
      values: { hours: Math.round(hoursSince(l.readySince, now)) },
      explanation: `Order ${l.orderNo} for ${l.party} has been Ready and allocated for ${Math.round(hoursSince(l.readySince, now))} hours with no Tally bill number.`,
    }));
}

/* ============================================================== logistics */

export function lrsMissing(transports: { id: string; billNo: string | null; party: string; billDate: string | null; lr: string | null }[], today: string, t: Thresholds): Candidate[] {
  return transports
    .filter((x) => !x.lr && x.billDate && daysBetween(x.billDate, today) > t.stuckLrDays)
    .map((x) => ({
      kind: "lrMissing" as const,
      subject: x.id,
      screen: "pendingLr",
      recordIds: [x.id],
      values: { days: daysBetween(x.billDate!, today) },
      explanation: `Bill ${x.billNo ?? "—"} for ${x.party} left ${daysBetween(x.billDate!, today)} days ago and has no LR number.`,
    }));
}

export function cnsNotIssued(reqs: { id: string; party: string; approvedAt: Date | null; issued: boolean; accepted: boolean; cn: boolean }[], now: Date, t: Thresholds): Candidate[] {
  return reqs
    .filter((r) => r.accepted && r.cn && !r.issued && r.approvedAt && hoursSince(r.approvedAt, now) > t.stuckCnDays * 24)
    .map((r) => ({
      kind: "cnNotIssued" as const,
      subject: r.id,
      screen: "issueCn",
      recordIds: [r.id],
      values: { days: Math.floor(hoursSince(r.approvedAt!, now) / 24) },
      explanation: `The credit note accepted for ${r.party} ${Math.floor(hoursSince(r.approvedAt!, now) / 24)} days ago has not been issued.`,
    }));
}

/* ============================================================== petty cash */

export function duplicateExpenses(exps: { id: string; by: string; amountPaise: number; particular: string | null; date: string }[], t: Thresholds): Candidate[] {
  const out: Candidate[] = [];
  const by = new Map<string, typeof exps>();
  for (const e of exps) by.set(`${e.by.toLowerCase()}|${e.amountPaise}|${(e.particular ?? "").toLowerCase()}`, [...(by.get(`${e.by.toLowerCase()}|${e.amountPaise}|${(e.particular ?? "").toLowerCase()}`) ?? []), e]);
  for (const xs of by.values()) {
    xs.sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 1; i < xs.length; i++)
      if (Math.abs(daysBetween(xs[i - 1].date, xs[i].date)) <= t.duplicateExpenseDays)
        out.push({
          kind: "duplicateExpense",
          subject: xs[i].id,
          screen: "expenses",
          recordIds: [xs[i - 1].id, xs[i].id],
          values: { amount: xs[i].amountPaise },
          explanation: `${xs[i].by} recorded ${rupees(xs[i].amountPaise)} for ${xs[i].particular ?? "the same particular"} twice within ${Math.abs(daysBetween(xs[i - 1].date, xs[i].date))} days.`,
        });
  }
  return out;
}

export function cashNegative(balances: { key: string; employee: string; godown: string; mode: string; availablePaise: number; ids: string[] }[]): Candidate[] {
  return balances
    .filter((b) => b.availablePaise < 0)
    .map((b) => ({
      kind: "cashNegative" as const,
      subject: b.key,
      screen: "expenses",
      recordIds: b.ids,
      values: { available: b.availablePaise },
      explanation: `${b.employee} has spent ${rupees(-b.availablePaise)} more than given at ${b.godown} (${b.mode}).`,
    }));
}

/* ================================================================== stock */

export function belowLevel(rows: { id: string; screen: "reorderRm" | "reorderFg"; item: string; godown: string; available: number; min: number }[]): Candidate[] {
  return rows.map((r) => ({
    kind: "belowLevel" as const,
    subject: `${r.screen}:${r.id}`,
    screen: r.screen,
    recordIds: [r.id],
    values: { available: r.available, min: r.min, item: r.item, godown: r.godown },
    explanation: `${r.item} at ${r.godown}: ${r.available} available against a minimum of ${r.min}.`,
  }));
}
