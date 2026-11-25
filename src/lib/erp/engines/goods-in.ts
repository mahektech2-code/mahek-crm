/* ---------------------------------------------------------------------------
 * GOODS IN, read as the gate reads it (Nov 2026).
 *
 *  - EXPECTED AT THE GATE: every PO line still to come, grouped by supplier and
 *    the godown it is to be delivered to — one truck is one supplier's delivery
 *    to one godown — the group with the most overdue line first, and within a
 *    group the late lines first, then by due date.
 *  - WHAT'S NEXT, once a GRN is saved: for each line, its drum labels, its
 *    testing and its bill, each said as what can be done now or what it waits
 *    for, from what the save itself did.
 *
 * PURE and client-safe: the server reads the lines and the save's routing and
 * hands them here; nothing in this file reads or writes anything.
 * ------------------------------------------------------------------------- */

import { daysUntil } from "./purchase-flow";

/** One PO line still waiting for goods, as the gate list needs it. */
export type GateLine = {
  /** The PO line's id: the row's id, and what Receive opens the GRN on. */
  lineId: string;
  poId: string;
  /** "PO-18" — the PO's name as every screen says it. */
  po: string;
  supplier: string;
  supplierId: string;
  /** The PO's deliver-to godown. */
  godown: string;
  item: string;
  type: string;
  unit: string;
  /** What the line now expects: its quantity plus live corrections. */
  expected: number;
  received: number;
  /** ISO date the PO asks for the goods by. */
  due: string | null;
  /** Paise per unit and GST basis points, for the money still to come. */
  ratePaise: number;
  gstBp: number;
};

export type GateRow = GateLine & {
  /** What is still to come on the line: expected less received, never below 0. */
  toCome: number;
  /** "Asian Solvents → Bhiwandi": the group it is listed under. */
  group: string;
  late: boolean;
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The key a line is grouped by: one supplier's delivery to one godown. */
export function gateGroup(l: Pick<GateLine, "supplier" | "godown">): string {
  return `${l.supplier} → ${l.godown}`;
}

const dueCmp = (a: string | null, b: string | null) => (a === b ? 0 : !a ? 1 : !b ? -1 : a < b ? -1 : 1);
const poNo = (po: string) => Number(po.replace(/\D+/g, "")) || 0;

/**
 * The lines still to come, in the order the gate reads them: only lines with
 * something left; groups ordered by their earliest due date (undated last),
 * then supplier and godown; within a group by due date — the late ones are the
 * earliest, so they come first — then PO number.
 */
export function expectedAtGate(lines: GateLine[], day: string): GateRow[] {
  const open = lines
    .map((l) => ({ ...l, toCome: round3(Math.max(0, l.expected - l.received)), group: gateGroup(l), late: !!l.due && l.due < day }))
    .filter((l) => l.toCome > 0);
  const first = new Map<string, string | null>();
  for (const l of open) {
    const at = first.get(l.group);
    if (at === undefined || dueCmp(l.due, at) < 0) first.set(l.group, l.due);
  }
  return open.sort(
    (a, b) =>
      dueCmp(first.get(a.group) ?? null, first.get(b.group) ?? null) ||
      a.supplier.localeCompare(b.supplier) ||
      a.godown.localeCompare(b.godown) ||
      dueCmp(a.due, b.due) ||
      poNo(a.po) - poNo(b.po) ||
      a.item.localeCompare(b.item),
  );
}

/**
 * What a group's heading says: "4 open lines · 2 late · ₹2,85,080 to come".
 * The money is said only to somebody who may see purchase money (`inr` given),
 * at each line's own rate with its GST.
 */
export function gateGroupLine(rows: Pick<GateRow, "toCome" | "late" | "due" | "ratePaise" | "gstBp">[], day: string, inr?: (paise: number) => string): string {
  const n = rows.length;
  const late = rows.filter((r) => r.late).length;
  const today = rows.filter((r) => r.due === day).length;
  const parts = [`${n} open line${n === 1 ? "" : "s"}`];
  if (late) parts.push(`${late} late`);
  else if (today) parts.push(today === n ? "due today" : `${today} due today`);
  if (inr) {
    const paise = rows.reduce((t, r) => t + Math.round(r.toCome * r.ratePaise * (1 + r.gstBp / 10_000)), 0);
    if (paise > 0) parts.push(`${inr(paise)} to come`);
  }
  return parts.join(" · ");
}

/** Whether a line is due within `days` of the business date, today included, and not late. */
export function dueWithin(due: string | null, day: string, days: number): boolean {
  if (!due) return false;
  const n = daysUntil(due, day);
  return n >= 0 && n <= days;
}

/**
 * The PO lines one "Receive from <supplier>" puts on one GRN: every open line
 * of the same supplier delivered to the same godown, in the gate's order — ONE
 * LINE PER ITEM, the one due first. A lot is the supplier, the item and the PR
 * (`lotNumber`), so the same item twice on one GRN would be the same lot twice
 * and the second line would stop at the register. What arrives for it is
 * received on that line (a difference corrects the PO); the item's other PO
 * lines stay at the gate for the next truck.
 */
export function supplierDelivery(rows: GateRow[], from: Pick<GateLine, "supplierId" | "godown">): GateRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (r.supplierId !== from.supplierId || r.godown !== from.godown || seen.has(r.item)) return false;
    seen.add(r.item);
    return true;
  });
}

/* ------------------------------------------------------------ what's next */

/** One line of a saved GRN, as the save left it. */
export type SavedGrnLine = {
  item: string;
  type: string;
  quantity: number;
  unit: string;
  drums: number | null;
  /** The lot number the line is (or will be, once tested) registered under. */
  lot: string;
  po: string;
  /** Where the save sent it: Testing, the register (Purchase), or nowhere — the lot number was taken. */
  routed: "Testing" | "Purchase" | null;
  /** The register row, where the save made one. */
  purchaseId: string | null;
};

export type NextStep =
  | { kind: "print"; label: string; href: string }
  | { kind: "record"; label: string; href: string }
  | { kind: "done"; label: string }
  | { kind: "waiting"; label: string; tone: "warn" | "neutral" }
  | { kind: "none"; label: string };

export type NextLine = {
  item: string;
  type: string;
  /** "1,500 Litre · 8 drums · lot AST1501 · PO-2". */
  facts: string;
  labels: NextStep;
  testing: NextStep;
  bill: NextStep;
};

export type NextOptions = {
  /** May open the drum-label print (holds a screen the print page answers to). */
  canLabels: boolean;
  /** May record the bill: Bills on the account, its Edit tick, and purchase money. */
  canBill: boolean;
  /** The team that tests an item of this category, if one does. */
  testedBy: (type: string) => string | null;
  labelsHref: (purchaseId: string) => string;
  billHref: (purchaseId: string) => string;
  nf: (n: number) => string;
};

/**
 * What is left to do on each saved line, from what the save did:
 *
 *  - Drum labels — a chemical in the register prints one label a drum, now;
 *    a chemical sent to testing has no lot in the register yet, so its labels
 *    wait for the test; anything else needs none.
 *  - Testing — sent to the team that tests it, or not required.
 *  - Bill — recorded on its register row on Bills, which a line in testing
 *    does not have yet: "To come".
 */
export function whatsNext(lines: SavedGrnLine[], o: NextOptions): NextLine[] {
  return lines.map((l) => {
    const chemical = l.type === "Chemical";
    const inRegister = l.routed === "Purchase" && !!l.purchaseId;
    const n = Math.max(1, l.drums ?? 1);
    const labels: NextStep = !chemical
      ? { kind: "none", label: "Not needed" }
      : inRegister
        ? o.canLabels
          ? { kind: "print", label: `Print ${n} label${n === 1 ? "" : "s"}`, href: o.labelsHref(l.purchaseId!) }
          : { kind: "waiting", label: "From Drum labels", tone: "neutral" }
        : l.routed === "Testing"
          ? { kind: "waiting", label: "After testing", tone: "neutral" }
          : { kind: "waiting", label: "Not in the register yet", tone: "warn" };
    const team = o.testedBy(l.type);
    const testing: NextStep =
      l.routed === "Testing"
        ? { kind: "waiting", label: `Sent to ${team ?? "Lot testing"}`, tone: "warn" }
        : l.routed === "Purchase"
          ? { kind: "none", label: "Not required" }
          : { kind: "waiting", label: "Not sent on — lot number taken", tone: "warn" };
    const bill: NextStep = inRegister && o.canBill ? { kind: "record", label: "Record bill", href: o.billHref(l.purchaseId!) } : { kind: "waiting", label: "To come", tone: "neutral" };
    const facts = [`${o.nf(l.quantity)} ${l.unit}`, l.drums ? `${o.nf(l.drums)} drum${l.drums === 1 ? "" : "s"}` : "", `lot ${l.lot}`, l.po].filter(Boolean).join(" · ");
    return { item: l.item, type: l.type, facts, labels, testing, bill };
  });
}

/** What a saved GRN hands back to its dialog's step 5. */
export type GrnNext = {
  pr: number;
  supplier: string;
  godown: string;
  /** The POs the receipt was against, by name. */
  pos: string[];
  lines: NextLine[];
};
