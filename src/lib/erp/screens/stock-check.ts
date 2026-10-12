import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { erpRequisitions, erpRmEntries, erpStockAdjustments, erpStockCounts, erpTransfers } from "@/db/schema";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { featureState, logSuggestion, readText } from "../ai";
import {
  ADJUSTMENT_REASONS,
  CONTROL_STEPS,
  COUNT_KIND_LABEL,
  COUNT_STATUS_LABEL,
  RESOLUTION_LABEL,
  adjustmentReasonByLabel,
  adjustmentReasonLabel,
  controlStep,
  recountOutcome,
  type Cause,
  type CountKind,
  type CountStatus,
  type Resolution,
} from "../engines/stock-check";
import { erpLink } from "../registry";
import { erpAudit, erpId, num, stampLine, text, type ScreenModule } from "../server";
import { countLabel, judgeOnShelf, missingRecords, openCount, openGodownCounts, planCycleCounts, shelfFacts, type ShelfFacts } from "../stock-check";
import { lockLot, rmLots } from "../stock";
import { checkableItems, floorCheckRows, recordFloorCheck, STAGE_LABEL, type CheckStage, type FloorCheckRow } from "../floor-checks";
import type { ActionSpec, ColSpec, FieldSpec, ListRow } from "../ui";
import { nf } from "../ui";
import { godownOptions, inTx, isErpManager, materials, refuse, type Tx } from "./common";
import { requirementLabel } from "../engines/purchase-flow";

/* ---------------------------------------------------------------------------
 * INVENTORY ACCURACY CONTROL — the Stock accuracy screen, five tabs:
 *
 *   To count · Red flags · Adjustments · Missing records · Every count
 *
 * A count is BLIND: nothing on the To count tab, its prompt or its drawer
 * shows the book, and the book is snapshotted at the moment the figure is
 * submitted. A red flag is recounted by somebody else, investigated, and
 * resolved by a holder of `stockControl`. Stock moves only through an
 * adjustment that somebody other than its requester approved.
 * ------------------------------------------------------------------------- */

const today = () => calendarDate(new Date());
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const signed = (x: number) => (x > 0 ? `+${nf(x)}` : nf(x));

/** Runs the day: opens counts, cancels them. Somebody with `stockControl`, or a manager. */
const runsCounts = (ctx: ErpContext) => isErpManager(ctx) || ctx.powers.has("stockControl");
const controls = (ctx: ErpContext) => ctx.powers.has("stockControl");

type CountRow = {
  id: string;
  no: number;
  kind: CountKind;
  status: CountStatus;
  rm: string;
  item: string;
  godownId: string;
  godown: string;
  unit: string;
  req: string | null;
  reqNo: number | null;
  parent: string | null;
  parentNo: number | null;
  /** Whoever counted the check a recount belongs to — they may not recount it. */
  parentCounterId: string | null;
  reason: string;
  due: string;
  assignee: string | null;
  counted: number | null;
  countedById: string | null;
  counter: string | null;
  countedAt: Date | null;
  book: number | null;
  pendingIn: number | null;
  pendingOut: number | null;
  difference: number | null;
  tolerance: number | null;
  ai: { summary?: string; ranked?: { title: string; why: string; likelihood: string; missing: string }[]; nextStep?: string; at?: string } | null;
  resolution: Resolution | null;
  resolutionNote: string | null;
  resolver: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
  bin: string | null;
  lotNote: string | null;
  countNote: string | null;
};

async function countRows(where = sql`true`): Promise<CountRow[]> {
  const rows = (await db.execute(sql`
    select c.id, c.count_no as no, c.kind, c.status, c.raw_material_id as rm, m.name as item, c.godown_id as "godownId", g.name as godown,
           c.unit, c.requisition_id as req, r.req_no as "reqNo", c.recount_of_id as parent, p.count_no as "parentNo",
           p.counted_by_id as "parentCounterId", c.reason,
           c.due_date::text as due, ua.name as assignee, c.counted_qty::float8 as counted, c.counted_by_id as "countedById",
           uc.name as counter, c.counted_at as "countedAt", c.book_qty::float8 as book, c.pending_in::float8 as "pendingIn",
           c.pending_out::float8 as "pendingOut", c.difference::float8 as difference, c.tolerance::float8 as tolerance,
           c.ai_causes as ai, c.resolution, c.resolution_note as "resolutionNote", ur.name as resolver, c.resolved_at as "resolvedAt",
           c.created_at as "createdAt", ub.name as "createdBy", c.bin, c.lot_note as "lotNote", c.count_note as "countNote"
      from erp_stock_counts c
      join erp_raw_materials m on m.id = c.raw_material_id
      join erp_godowns g on g.id = c.godown_id
      left join erp_requisitions r on r.id = c.requisition_id
      left join erp_stock_counts p on p.id = c.recount_of_id
      left join users ua on ua.id = c.assigned_to_id
      left join users uc on uc.id = c.counted_by_id
      left join users ur on ur.id = c.resolved_by_id
      left join users ub on ub.id = c.created_by_id
     where ${where}
     order by c.created_at desc
  `)) as unknown as CountRow[];
  return rows.map((r) => ({ ...r, no: Number(r.no), reqNo: r.reqNo == null ? null : Number(r.reqNo), parentNo: r.parentNo == null ? null : Number(r.parentNo) }));
}

/** The figure to believe for a check: the newest anybody counted, the root or a recount of it. */
function latestCount(root: CountRow, all: CountRow[]): CountRow | null {
  return (
    [root, ...all.filter((c) => c.parent === root.id)]
      .filter((c) => c.countedAt)
      .sort((a, b) => +new Date(b.countedAt as Date) - +new Date(a.countedAt as Date))[0] ?? null
  );
}

const reconciledOf = (c: CountRow) => (c.book == null ? null : r3(c.book + (c.pendingIn ?? 0) - (c.pendingOut ?? 0)));

/* ------------------------------------------------------------ the panel */

export type StockCountPanel = {
  steps: string[];
  step: number;
  blind: boolean;
  number: string;
  kind: string;
  reason: string;
  item: string;
  godown: string;
  unit: string;
  requirement: { label: string; href: string } | null;
  counted: number | null;
  reconciled: number | null;
  book: number | null;
  pendingIn: number | null;
  difference: number | null;
  tolerance: number | null;
  history: { label: string; who: string | null; qty: number | null; at: string | null; note: string | null }[];
  causes: (Cause & { href: string | null })[];
  ai: CountRow["ai"];
  adjustment: { qty: number; reason: string; status: string; by: string | null; decidedBy: string | null; note: string | null } | null;
  resolution: { label: string; note: string | null; by: string | null } | null;
};

function panelFor(c: CountRow, all: CountRow[], facts: ShelfFacts | null, adj: AdjRow | null): ListRow["panel"] {
  const blind = c.status === "open";
  const latest = blind ? null : latestCount(c, all);
  const recon = blind ? null : reconciledOf(latest ?? c);
  const causes = !blind && facts && latest?.counted != null && ["flagged", "recount", "investigating"].includes(c.status) ? judgeOnShelf(facts, latest.counted).causes : [];
  const data: StockCountPanel = {
    steps: [...CONTROL_STEPS],
    step: c.parent ? (blind ? 2 : 3) : controlStep(c.status, adj?.status === "pending"),
    blind,
    number: countLabel(c.no),
    kind: COUNT_KIND_LABEL[c.kind],
    reason: c.reason,
    item: c.item,
    godown: c.godown,
    unit: c.unit,
    requirement: c.req ? { label: c.reqNo ? requirementLabel(c.reqNo) : "Purchase requirement", href: erpLink("requisitions", { open: c.req }) } : null,
    counted: latest?.counted ?? null,
    reconciled: recon,
    book: blind ? null : (latest ?? c).book,
    pendingIn: blind ? null : (latest ?? c).pendingIn,
    difference: blind ? null : (latest ?? c).difference,
    tolerance: blind ? null : (latest ?? c).tolerance,
    history: blind
      ? []
      : [c, ...all.filter((x) => x.parent === c.id)]
          .sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
          .map((x) => ({
            label: x.parent ? `Recount ${countLabel(x.no)}` : `Count ${countLabel(x.no)}`,
            who: x.counter,
            qty: x.counted,
            at: x.countedAt ? stampLine(null, x.countedAt).replace(/^Created /, "") : null,
            note: x.countNote,
          })),
    causes: causes.map((k) => ({ ...k, href: k.screen ? erpLink(k.screen, k.ids.length ? { f: k.ids.join(","), fl: k.title } : {}) : null })),
    ai: blind ? null : c.ai,
    adjustment: adj ? { qty: adj.qty, reason: `${adjustmentReasonLabel(adj.reasonCode)} — ${adj.reason}`, status: adj.status, by: adj.requester, decidedBy: adj.decider, note: adj.note } : null,
    resolution: c.resolution ? { label: RESOLUTION_LABEL[c.resolution], note: c.resolutionNote, by: c.resolver } : null,
  };
  return { kind: "stockCount", data };
}

type AdjRow = {
  id: string;
  countId: string;
  countNo: number;
  item: string;
  godown: string;
  unit: string;
  qty: number;
  reasonCode: string;
  reason: string;
  status: string;
  requestedById: string | null;
  requester: string | null;
  decider: string | null;
  note: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
};

async function adjustmentRows(where = sql`true`): Promise<AdjRow[]> {
  const rows = (await db.execute(sql`
    select a.id, a.count_id as "countId", c.count_no as "countNo", m.name as item, g.name as godown, c.unit, a.quantity::float8 as qty,
           a.reason_code as "reasonCode", a.reason, a.status, a.requested_by_id as "requestedById", ur.name as requester, ud.name as decider,
           a.decision_note as note, a.requested_at as "requestedAt", a.decided_at as "decidedAt"
      from erp_stock_adjustments a
      join erp_stock_counts c on c.id = a.count_id
      join erp_raw_materials m on m.id = a.raw_material_id
      join erp_godowns g on g.id = a.godown_id
      left join users ur on ur.id = a.requested_by_id
      left join users ud on ud.id = a.decided_by_id
     where ${where}
     order by a.requested_at desc
  `)) as unknown as AdjRow[];
  return rows.map((r) => ({ ...r, countNo: Number(r.countNo), qty: Number(r.qty) }));
}

/* ------------------------------------------------------------- the prompts */

function countPrompt(c: CountRow): ActionSpec["prompt"] {
  return {
    title: `Count ${c.item} at ${c.godown}`,
    sub: `${c.parent ? `Independent recount of ${countLabel(c.parentNo ?? 0)}. ` : ""}Count every drum, can or box of it on the shelf, in ${c.unit === "Pcs" ? "pieces" : "litres"}. The book quantity is not shown until your count is in.`,
    submit: "Submit count",
    fields: [
      { k: "qty", l: `Counted (${c.unit})`, t: "num", req: true, min: 0 },
      { k: "bin", l: "Where on the floor", t: "text", hint: "Bay, rack or bin — so a recount looks in the same place." },
      { k: "lot", l: "Batch or lot seen", t: "text", hint: "The lot numbers on the drums, if any." },
      { k: "note", l: "Note", t: "area", mic: true },
    ],
  };
}

/* ------------------------------------------------------------ To count */

const countTasks: ScreenModule = {
  key: "countTasks",
  async load(ctx) {
    const [rows, mats, gds] = await Promise.all([countRows(sql`c.status = 'open'`), materials(), godownOptions(ctx, { lost: false })]);
    const day = today();
    const cols: ColSpec[] = [
      { k: "no", l: "Count", t: "mono" },
      { k: "due", l: "Due", t: "d" },
      { k: "kind", l: "Kind", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "reason", l: "Why", t: "t", w: 320 },
      { k: "assignee", l: "Counter", t: "t" },
      { k: "f", l: "Flags", t: "f" },
    ];
    const askFields: FieldSpec[] = [
      { k: "what", l: "Count", t: "select", req: true, opts: ["One item at a godown", "Every item at a godown (full count)", "Today's cycle counts"], def: "One item at a godown" },
      { k: "item", l: "Item", t: "select", opts: mats.map((m) => m.name), reqWhen: { k: "what", eq: "One item at a godown" }, when: { k: "what", eq: "One item at a godown" } },
      { k: "godown", l: "Godown", t: "select", opts: gds.map((g) => g.name), reqWhen: { k: "what", in: ["One item at a godown", "Every item at a godown (full count)"] }, when: { k: "what", in: ["One item at a godown", "Every item at a godown (full count)"] } },
      { k: "reason", l: "Why", t: "area", mic: true, hint: "A spill, a move, a doubt — read by whoever counts it." },
    ];
    return {
      spec: {
        screen: "countTasks",
        cols,
        hidden: [],
        groups: ["godown"],
        chips: "kind",
        godownKey: "godown",
        sortDefault: ["due", 1],
        newForm: runsCounts(ctx) ? { screen: "countTasks", id: "ask", title: "Ask for a count", sub: "Counts open for anybody at the godown. A cycle count picks today's items by ABC class, how overdue, how much they move and how often they were wrong.", submit: "Open counts", header: askFields } : undefined,
        newLabel: "Ask for a count",
        noDataLine: "Nothing to count. Counts appear here when a purchase is requested, each morning for the cycle count, and whenever somebody asks for one.",
      },
      rows: rows.map((c): ListRow => {
        const sameCounter = !!c.parent && c.parentCounterId === ctx.user.id;
        return {
          id: c.id,
          v: { no: countLabel(c.no), due: c.due, kind: COUNT_KIND_LABEL[c.kind], item: c.item, godown: c.godown, unit: c.unit, reason: c.reason, assignee: c.assignee ?? "Anybody at the godown" },
          flags: [...(c.due < day ? ["countOverdue"] : []), ...(c.parent ? ["recount"] : []), ...(c.req ? ["forPurchase"] : [])],
          title: `${countLabel(c.no)} · ${c.item}`,
          header: `${c.godown} · ${COUNT_KIND_LABEL[c.kind]} · due ${c.due}`,
          actions: [
            { id: "count", l: "Count it", primary: true, prompt: countPrompt(c), why: sameCounter ? "A recount is done by somebody other than whoever counted first" : "" },
            ...(runsCounts(ctx) ? [{ id: "cancel", l: "Cancel count", prompt: { title: "Cancel this count", sub: `${countLabel(c.no)} · ${c.item} at ${c.godown}`, submit: "Cancel count", fields: [{ k: "reason", l: "Why", t: "area" as const, req: true }] } }] : []),
          ],
          panel: panelFor(c, rows, null, null),
          by: stampLine(c.createdBy, c.createdAt),
        };
      }),
    };
  },
  forms: {
    async ask(ctx, h) {
      if (!runsCounts(ctx)) return err("A manager or somebody who controls stock accuracy opens counts.", "not_permitted");
      const what = text(h.what) ?? "";
      if (what === "Today's cycle counts") {
        const r = await planCycleCounts(ctx.user.id);
        await erpAudit(ctx, "erp.stockCount.cycle", "erp_stock_count", null, null, r);
        return r.skipped ? okVoid(`Nothing opened: ${r.skipped}.`) : okVoid(`${r.opened} cycle count${r.opened === 1 ? "" : "s"} opened`);
      }
      const gds = await godownOptions(ctx, { lost: false });
      const g = gds.find((x) => x.name === text(h.godown));
      if (!g) return fieldErr("godown", "Pick the godown");
      const reason = text(h.reason);
      if (what === "Every item at a godown (full count)") {
        const n = await openGodownCounts(g.id, "full", reason ? `Full count — ${reason}` : "Full count of the godown", ctx.user.id);
        await erpAudit(ctx, "erp.stockCount.full", "erp_stock_count", null, null, { godown: g.name, opened: n });
        return okVoid(`${n} count${n === 1 ? "" : "s"} opened at ${g.name}`);
      }
      const m = (await materials()).find((x) => x.name === text(h.item));
      if (!m) return fieldErr("item", "Pick the item");
      if (!reason) return fieldErr("reason", "Say why it is being counted");
      const r = await db.transaction((tx) => openCount(tx, { kind: "event", rawMaterialId: m.id, godownId: g.id, reason, byId: ctx.user.id }));
      await erpAudit(ctx, "erp.stockCount.open", "erp_stock_count", r.id, null, { item: m.name, godown: g.name, reason });
      return okVoid(r.created ? `${countLabel(r.countNo)} opened` : `${countLabel(r.countNo)} is already open for that shelf`);
    },
  },
  actions: {
    count: (ctx, id, v) => submitCount(ctx, id, v),
    async cancel(ctx, id, v) {
      if (!runsCounts(ctx)) return err("A manager or somebody who controls stock accuracy cancels a count.", "not_permitted");
      const reason = text(v.reason);
      if (!reason) return fieldErr("reason", "Say why");
      const [c] = await countRows(sql`c.id = ${id}`);
      if (!c || c.status !== "open") return err("That count is no longer open.", "conflict");
      await db.transaction(async (tx) => {
        await tx.update(erpStockCounts).set({ status: "cancelled", resolution: "cancelled", resolutionNote: reason, resolvedById: ctx.user.id, resolvedAt: new Date() }).where(eq(erpStockCounts.id, id));
        /* A cancelled recount hands its parent back to the red flags, to be recounted again. */
        if (c.parent) await tx.update(erpStockCounts).set({ status: "flagged" }).where(and(eq(erpStockCounts.id, c.parent), eq(erpStockCounts.status, "recount")));
      });
      await erpAudit(ctx, "erp.stockCount.cancel", "erp_stock_count", id, null, { reason });
      return okVoid(`${countLabel(c.no)} cancelled`);
    },
  },
};

/**
 * Submits one count. The book is read and SNAPSHOTTED here, inside the same
 * transaction as the figure, and only now shown back. A recount judges the
 * check it belongs to: the book confirmed, the difference confirmed, or two
 * counts that agree with nothing and a third needed.
 */
export async function submitCount(ctx: ErpContext, id: string, v: Record<string, string>): Promise<Result<unknown>> {
  const qty = num(v.qty);
  if (qty == null || qty < 0) return fieldErr("qty", "Enter what you counted — zero if the shelf is empty");
  let message = "";
  const res = await inTx(async (tx) => {
    const [c] = (await tx.execute(sql`select * from erp_stock_counts where id = ${id} for update`)) as unknown as {
      id: string; status: string; count_no: number; raw_material_id: string; godown_id: string; recount_of_id: string | null; requisition_id: string | null;
    }[];
    if (!c || c.status !== "open") return refuse(err("That count is no longer open.", "conflict"));
    type Parent = { id: string; counted_by_id: string | null; difference: number | null; count_no: number };
    let parent: Parent | null = null;
    if (c.recount_of_id) {
      [parent] = (await tx.execute(sql`select id, counted_by_id, difference::float8 as difference, count_no from erp_stock_counts where id = ${c.recount_of_id} for update`)) as unknown as Parent[];
      if (parent?.counted_by_id === ctx.user.id) return refuse(err("A recount is done by somebody other than whoever counted first.", "not_permitted"));
    }
    const facts = await shelfFacts(c.raw_material_id, c.godown_id, tx);
    const j = judgeOnShelf(facts, qty);
    const status: CountStatus = j.verdict;
    await tx
      .update(erpStockCounts)
      .set({
        countedQty: qty,
        countedAt: new Date(),
        countedById: ctx.user.id,
        bin: text(v.bin),
        lotNote: text(v.lot),
        countNote: text(v.note),
        bookQty: facts.book,
        pendingIn: facts.pendingIn,
        pendingOut: facts.pendingOut,
        difference: j.difference,
        tolerance: j.tolerance,
        status,
      })
      .where(eq(erpStockCounts.id, id));
    const said = `Counted ${nf(qty)} ${facts.unit} · book ${nf(j.reconciled)}${facts.pendingIn ? ` (incl. ${nf(facts.pendingIn)} not yet posted)` : ""}`;
    if (parent) {
      /* The first count, carried to today's book: the book may have moved between the two. */
      const first = r3(j.reconciled + Number(parent.difference ?? 0));
      const outcome = recountOutcome({ first, second: qty, reconciled: j.reconciled, tolerance: j.tolerance });
      if (outcome === "book_confirmed") {
        await tx
          .update(erpStockCounts)
          .set({ status: "resolved", resolution: "book_confirmed", resolutionNote: `The recount ${countLabel(c.count_no)} matched the book; the first count was wrong.`, resolvedById: ctx.user.id, resolvedAt: new Date() })
          .where(eq(erpStockCounts.id, parent.id));
        message = `${said}. The recount matches the book — ${countLabel(parent.count_no)} is resolved and the purchase can continue.`;
      } else if (outcome === "discrepancy_confirmed") {
        await tx.update(erpStockCounts).set({ status: "investigating" }).where(eq(erpStockCounts.id, parent.id));
        message = `${said}. The recount confirms a difference of ${signed(j.difference)} — ${countLabel(parent.count_no)} is now being investigated.`;
      } else {
        await tx.update(erpStockCounts).set({ status: "flagged" }).where(eq(erpStockCounts.id, parent.id));
        message = `${said}. The recount agrees with neither the book nor the first count — ${countLabel(parent.count_no)} needs another recount.`;
      }
    } else {
      message = status === "matched" ? `${said}. Matches the book.` : `${said}. Red flag: ${signed(j.difference)} ${facts.unit}, beyond the ${nf(j.tolerance)} tolerance — a recount by somebody else comes next.`;
    }
    return okVoid(message);
  });
  if (res.ok) await erpAudit(ctx, "erp.stockCount.submit", "erp_stock_count", id, null, { counted: qty });
  return res;
}

/* ------------------------------------------------------------ Red flags */

const stockFlags: ScreenModule = {
  key: "stockFlags",
  async load(ctx) {
    const [roots, children, adjs] = await Promise.all([
      countRows(sql`c.recount_of_id is null and c.status in ('flagged', 'recount', 'investigating')`),
      countRows(sql`c.recount_of_id is not null`),
      adjustmentRows(sql`a.status = 'pending'`),
    ]);
    const all = [...roots, ...children];
    const facts = new Map<string, ShelfFacts>();
    for (const c of roots) {
      const k = `${c.rm}|${c.godownId}`;
      if (!facts.has(k)) facts.set(k, await shelfFacts(c.rm, c.godownId));
    }
    const cols: ColSpec[] = [
      { k: "no", l: "Count", t: "mono" },
      { k: "status", l: "Status", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "counted", l: "Counted", t: "n" },
      { k: "book", l: "Book", t: "n" },
      { k: "diff", l: "Difference", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "requirement", l: "Requirement", t: "mono" },
      { k: "counter", l: "Counted by", t: "t" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "stockFlags",
        cols,
        hidden: [],
        groups: ["status"],
        chips: "status",
        godownKey: "godown",
        noDataLine: "No red flags. A count that differs from the book beyond its tolerance lands here until it is recounted, investigated and resolved.",
      },
      rows: roots.map((c): ListRow => {
        const latest = latestCount(c, all) ?? c;
        const adj = adjs.find((a) => a.countId === c.id) ?? null;
        const openChild = children.some((x) => x.parent === c.id && x.status === "open");
        const actions: ActionSpec[] = [];
        if (c.status === "flagged" && !openChild)
          actions.push({
            id: "recount",
            l: "Ask for a recount",
            primary: true,
            prompt: { title: "Independent recount", sub: `${c.item} at ${c.godown}. Somebody other than ${latest.counter ?? "the first counter"} counts the shelf again, blind.`, submit: "Open the recount", fields: [{ k: "note", l: "Anything the recounter should know", t: "area", mic: true }] },
          });
        if (openChild) actions.push({ id: "openRecount", l: "Open the recount", href: erpLink("countTasks", { f: children.filter((x) => x.parent === c.id && x.status === "open").map((x) => x.id).join(","), fl: `Recount of ${countLabel(c.no)}` }) });
        actions.push({ id: "explain", l: "Suggest causes", ai: true });
        if (c.status === "investigating") {
          actions.push({
            id: "missingEntry",
            l: "The missing record is entered",
            why: controls(ctx) ? "" : "Resolving a discrepancy needs the stock-control power",
            prompt: {
              title: "Resolve: the missing record is now entered",
              sub: "Enter the missing receipt or issue on its own screen first. The book is read again and must now agree with the count.",
              submit: "Check and resolve",
              fields: [{ k: "note", l: "What was missing and where it was entered", t: "area", req: true, mic: true }],
            },
          });
          if (!adj)
            actions.push({
              id: "adjust",
              l: "Request an adjustment",
              prompt: {
                title: "Request a stock adjustment",
                sub: `The book is changed to what was counted (${nf(latest.counted ?? 0)} ${c.unit}). A shortage is written off to Item Lost Record; a surplus is entered. It posts only once somebody else approves it.`,
                submit: "Request adjustment",
                fields: [
                  { k: "reasonCode", l: "Reason", t: "select", req: true, opts: ADJUSTMENT_REASONS.map((r) => r.label) },
                  { k: "reason", l: "What happened", t: "area", req: true, mic: true, hint: "At least ten characters — read by whoever approves it and by the audit." },
                ],
              },
            });
        }
        if (runsCounts(ctx)) actions.push({ id: "cancelFlag", l: "Cancel", prompt: { title: "Cancel this check", sub: "Only for a count opened by mistake. A real difference is resolved, not cancelled.", submit: "Cancel check", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
        return {
          id: c.id,
          v: {
            no: countLabel(c.no),
            status: COUNT_STATUS_LABEL[c.status],
            item: c.item,
            godown: c.godown,
            counted: latest.counted,
            book: reconciledOf(latest),
            diff: latest.difference,
            unit: c.unit,
            requirement: c.reqNo ? requirementLabel(c.reqNo) : null,
            counter: latest.counter,
          },
          flags: [...(c.req ? ["forPurchase"] : []), ...(adj ? ["adjustmentPending"] : [])],
          title: `${countLabel(c.no)} · ${c.item}`,
          header: `${c.godown} · ${COUNT_STATUS_LABEL[c.status]} · ${signed(latest.difference ?? 0)} ${c.unit} against the book`,
          actions,
          panel: panelFor(c, all, facts.get(`${c.rm}|${c.godownId}`) ?? null, adj),
          by: stampLine(c.createdBy, c.createdAt),
        };
      }),
    };
  },
  actions: {
    async recount(ctx, id, v) {
      const [c] = await countRows(sql`c.id = ${id}`);
      if (!c || c.status !== "flagged") return err("Only a red-flagged count is recounted.", "conflict");
      const r = await inTx(async (tx) => {
        const opened = await openCount(tx, {
          kind: "recount",
          rawMaterialId: c.rm,
          godownId: c.godownId,
          recountOfId: c.id,
          requisitionId: c.req,
          reason: `Independent recount of ${countLabel(c.no)}${text(v.note) ? ` — ${text(v.note)}` : ""}`,
          byId: ctx.user.id,
        });
        await tx.update(erpStockCounts).set({ status: "recount" }).where(eq(erpStockCounts.id, c.id));
        return okVoid(`${countLabel(opened.countNo)} opened — somebody other than ${c.counter ?? "the first counter"} counts it`);
      });
      if (r.ok) await erpAudit(ctx, "erp.stockCount.recount", "erp_stock_count", id, null, { note: text(v.note) });
      return r;
    },
    explain: (ctx, id) => explainCount(ctx, id),
    async missingEntry(ctx, id, v) {
      if (!controls(ctx)) return err("Resolving a discrepancy needs the stock-control power.", "not_permitted");
      const note = text(v.note);
      if (!note || note.length < 10) return fieldErr("note", "Say what was missing and where it was entered");
      const all = await countRows(sql`c.id = ${id} or c.recount_of_id = ${id}`);
      const c = all.find((x) => x.id === id);
      if (!c || c.status !== "investigating") return err("Only a discrepancy under investigation is resolved this way.", "conflict");
      const latest = latestCount(c, all);
      if (latest?.counted == null) return err("Nothing has been counted for this check.", "conflict");
      const j = judgeOnShelf(await shelfFacts(c.rm, c.godownId), latest.counted);
      if (j.verdict !== "matched")
        return err(`The book still differs from the count by ${signed(j.difference)} ${c.unit} (book ${nf(j.reconciled)}, counted ${nf(latest.counted)}). Enter the rest, or request an adjustment for it.`, "rule_violation");
      await db.update(erpStockCounts).set({ status: "resolved", resolution: "missing_entry", resolutionNote: note, resolvedById: ctx.user.id, resolvedAt: new Date() }).where(eq(erpStockCounts.id, id));
      await erpAudit(ctx, "erp.stockCount.resolve", "erp_stock_count", id, null, { resolution: "missing_entry", note, book: j.reconciled });
      return okVoid(`${countLabel(c.no)} resolved — the book now agrees with the count`);
    },
    async adjust(ctx, id, v) {
      const code = adjustmentReasonByLabel(text(v.reasonCode));
      if (!code) return fieldErr("reasonCode", "Pick a reason");
      const reason = text(v.reason);
      if (!reason || reason.length < 10) return fieldErr("reason", "Say what happened, in at least ten characters");
      const all = await countRows(sql`c.id = ${id} or c.recount_of_id = ${id}`);
      const c = all.find((x) => x.id === id);
      if (!c || c.status !== "investigating") return err("An adjustment is requested once a recount has confirmed the difference.", "conflict");
      const latest = latestCount(c, all);
      if (latest?.counted == null) return err("Nothing has been counted for this check.", "conflict");
      const j = judgeOnShelf(await shelfFacts(c.rm, c.godownId), latest.counted);
      /* The adjustment moves the LEDGER book to what was counted, net of goods still on their way into it. */
      const qty = r3(j.difference);
      if (Math.abs(qty) < 0.0005) return err("The book already agrees with the count — resolve it instead.", "conflict");
      const adjId = erpId("esa");
      try {
        await db.insert(erpStockAdjustments).values({ id: adjId, countId: c.id, rawMaterialId: c.rm, godownId: c.godownId, quantity: qty, reasonCode: code, reason, requestedById: ctx.user.id });
      } catch {
        return err("An adjustment for this count is already waiting for a decision.", "conflict");
      }
      await erpAudit(ctx, "erp.stockAdjustment.request", "erp_stock_adjustment", adjId, null, { count: countLabel(c.no), qty, code, reason });
      return okVoid(`Adjustment of ${signed(qty)} ${c.unit} requested — it posts once somebody else approves it`);
    },
    async cancelFlag(ctx, id, v) {
      if (!runsCounts(ctx)) return err("A manager or somebody who controls stock accuracy cancels a check.", "not_permitted");
      const reason = text(v.reason);
      if (!reason) return fieldErr("reason", "Say why");
      const pending = await adjustmentRows(sql`a.count_id = ${id} and a.status = 'pending'`);
      if (pending.length) return err("An adjustment for this check is waiting for a decision — decide it first.", "conflict");
      await db.transaction(async (tx) => {
        await tx.update(erpStockCounts).set({ status: "cancelled", resolution: "cancelled", resolutionNote: reason, resolvedById: ctx.user.id, resolvedAt: new Date() }).where(eq(erpStockCounts.id, id));
        await tx.update(erpStockCounts).set({ status: "cancelled", resolution: "cancelled", resolutionNote: reason }).where(and(eq(erpStockCounts.recountOfId, id), eq(erpStockCounts.status, "open")));
      });
      await erpAudit(ctx, "erp.stockCount.cancel", "erp_stock_count", id, null, { reason });
      return okVoid("Check cancelled");
    },
  },
};

/**
 * The discrepancy assistant. The RULES find the records (`causeCandidates`);
 * the model, where it is switched on, only ranks and explains them in words.
 * It is told what each record is and never asked to invent one, and its
 * answer is stored on the count as a suggestion — nothing is created.
 */
async function explainCount(ctx: ErpContext, id: string): Promise<Result<unknown>> {
  const all = await countRows(sql`c.id = ${id} or c.recount_of_id = ${id}`);
  const c = all.find((x) => x.id === id);
  if (!c) return err("That count no longer exists.", "not_found");
  const latest = latestCount(c, all);
  if (latest?.counted == null) return err("Nothing has been counted yet — the causes are read against a count.", "conflict");
  const facts = await shelfFacts(c.rm, c.godownId);
  const j = judgeOnShelf(facts, latest.counted);
  if (j.verdict === "matched") return okVoid("The book agrees with the count now — there is nothing left to explain.");
  const state = await featureState("stockCheck");
  if (!state.on) return okVoid(`${j.causes.length} possible cause${j.causes.length === 1 ? "" : "s"} listed from the records. ${state.reason}`);
  const read = await readText({
    label: "ERP stock discrepancy",
    system:
      "You help a paint factory's storekeeper explain a difference between a physical stock count and the book. You are given the figures and a list of RECORDS the system found. Rank only those records as possible causes and say in one plain sentence each why. Distinguish a missing TRANSACTION (the goods are there, a record is not) from a missing PHYSICAL item (the record is right, the goods are gone). Never invent a record, a quantity or a date that is not given. Never conclude theft. Suggest the next step a person should take; do not claim anything has been entered.",
    prompt: JSON.stringify({
      item: c.item,
      godown: c.godown,
      unit: facts.unit,
      counted: latest.counted,
      book: facts.book,
      notYetPosted: facts.pendingIn,
      difference: j.difference,
      tolerance: j.tolerance,
      records: j.causes.map((k) => ({ title: k.title, detail: k.detail, quantity: k.qty, missing: k.missing, rulesSay: k.likelihood })),
    }),
    schema: z.object({
      summary: z.string(),
      ranked: z.array(z.object({ title: z.string(), why: z.string(), likelihood: z.enum(["likely", "possible", "unlikely"]), missing: z.enum(["transaction", "physical"]) })).max(8),
      nextStep: z.string(),
    }),
    shapeHint: '{"summary": string, "ranked": [{"title": string, "why": string, "likelihood": "likely"|"possible"|"unlikely", "missing": "transaction"|"physical"}], "nextStep": string}',
  });
  if (!read.output) return okVoid(`${j.causes.length} possible cause${j.causes.length === 1 ? "" : "s"} listed from the records. The assistant could not answer just now.`);
  const known = new Set(j.causes.map((k) => k.title));
  const ranked = read.output.ranked.filter((r) => known.has(r.title));
  const ai = { summary: read.output.summary, ranked, nextStep: read.output.nextStep, at: new Date().toISOString(), model: read.model };
  await db.update(erpStockCounts).set({ aiCauses: ai }).where(eq(erpStockCounts.id, id));
  await logSuggestion({ feature: "stockCheck", recordType: "stock_count", recordId: id, inputRef: "count", proposed: ai, servedBy: read.model, userId: ctx.user.id });
  return okVoid("Causes suggested — open the record to read them. Nothing has been entered.");
}

/* ---------------------------------------------------------- Adjustments */

const stockAdjustments: ScreenModule = {
  key: "stockAdjustments",
  async load(ctx) {
    const rows = await adjustmentRows();
    const cols: ColSpec[] = [
      { k: "count", l: "Count", t: "mono" },
      { k: "status", l: "Status", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "qty", l: "Adjustment", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "reason", l: "Reason", t: "t", w: 300 },
      { k: "requester", l: "Requested by", t: "t" },
      { k: "decider", l: "Decided by", t: "t" },
    ];
    return {
      spec: {
        screen: "stockAdjustments",
        cols,
        hidden: [],
        groups: ["status"],
        chips: "status",
        godownKey: "godown",
        noDataLine: "No adjustments. Stock changes here only from a confirmed discrepancy, and only once somebody other than the requester approves it.",
      },
      rows: rows.map((a): ListRow => {
        const own = a.requestedById === ctx.user.id && !ctx.administrator;
        const why = !controls(ctx) ? "Approving an adjustment needs the stock-control power" : own ? "Somebody other than the requester decides it" : "";
        return {
          id: a.id,
          v: { count: countLabel(a.countNo), status: STATUS_WORD[a.status] ?? a.status, item: a.item, godown: a.godown, qty: a.qty, unit: a.unit, reason: `${adjustmentReasonLabel(a.reasonCode)} — ${a.reason}`, requester: a.requester, decider: a.decider },
          flags: a.qty < 0 ? ["shortage"] : ["surplus"],
          title: `${signed(a.qty)} ${a.unit} · ${a.item}`,
          header: `${a.godown} · ${countLabel(a.countNo)} · ${adjustmentReasonLabel(a.reasonCode)}`,
          fields: [
            { l: "What happened", v: a.reason },
            { l: "Posts as", v: a.qty < 0 ? "A write-off to Item Lost Record, oldest lot first" : "A stock entry on the newest lot" },
            ...(a.note ? [{ l: "Decision note", v: a.note }] : []),
          ],
          actions:
            a.status === "pending"
              ? [
                  { id: "approve", l: "Approve and post", primary: true, why, confirm: `Post ${signed(a.qty)} ${a.unit} of ${a.item} at ${a.godown}? This changes the stock book and cannot be edited afterwards.` },
                  { id: "reject", l: "Reject", why, prompt: { title: "Reject the adjustment", sub: "The count goes back to being investigated.", submit: "Reject", fields: [{ k: "note", l: "Why", t: "area", req: true }] } },
                  { id: "openCount", l: `Open ${countLabel(a.countNo)}`, href: erpLink("stockFlags", { open: a.countId }) },
                ]
              : [{ id: "openCount", l: `Open ${countLabel(a.countNo)}`, href: erpLink("stockCounts", { open: a.countId }) }],
          by: stampLine(a.requester, a.requestedAt),
        };
      }),
    };
  },
  actions: {
    approve: (ctx, id) => decideAdjustment(ctx, id, "approved", null),
    reject: async (ctx, id, v) => {
      const note = text(v.note);
      if (!note) return fieldErr("note", "Say why");
      return decideAdjustment(ctx, id, "rejected", note);
    },
  },
};

const STATUS_WORD: Record<string, string> = { pending: "Pending approval", approved: "Approved", rejected: "Rejected" };

/**
 * Approving POSTS the adjustment, in one transaction with the decision: a
 * shortage is written off to Item Lost Record as transfers, oldest lot first,
 * and refused if the lots do not hold it (no negative stock); a surplus is an
 * inflow entry of its own on the newest lot. Its count is resolved with it.
 */
async function decideAdjustment(ctx: ErpContext, id: string, decision: "approved" | "rejected", note: string | null): Promise<Result<unknown>> {
  if (!controls(ctx)) return err("Approving an adjustment needs the stock-control power.", "not_permitted");
  const res = await inTx(async (tx) => {
    const [a] = (await tx.execute(sql`select a.*, a.quantity::float8 as qty, c.count_no, m.name as item from erp_stock_adjustments a
      join erp_stock_counts c on c.id = a.count_id join erp_raw_materials m on m.id = a.raw_material_id where a.id = ${id} for update of a`)) as unknown as {
      id: string; count_id: string; raw_material_id: string; godown_id: string; qty: number; status: string; requested_by_id: string | null; count_no: number; item: string; reason: string; reason_code: string;
    }[];
    if (!a || a.status !== "pending") return refuse(err("That adjustment has already been decided.", "conflict"));
    if (a.requested_by_id === ctx.user.id && !ctx.administrator) return refuse(err("Somebody other than the requester decides an adjustment.", "not_permitted"));
    if (decision === "rejected") {
      await tx.update(erpStockAdjustments).set({ status: "rejected", decidedById: ctx.user.id, decidedAt: new Date(), decisionNote: note }).where(eq(erpStockAdjustments.id, id));
      return okVoid("Rejected — the count is back under investigation");
    }
    const posted = await postAdjustment(tx, { id: a.id, rm: a.raw_material_id, godown: a.godown_id, qty: Number(a.qty), item: a.item, countNo: Number(a.count_no), reason: `${adjustmentReasonLabel(a.reason_code)}: ${a.reason}`, byId: ctx.user.id });
    await tx.update(erpStockAdjustments).set({ status: "approved", decidedById: ctx.user.id, decidedAt: new Date(), decisionNote: note, posted }).where(eq(erpStockAdjustments.id, id));
    await tx
      .update(erpStockCounts)
      .set({ status: "resolved", resolution: "adjusted", resolutionNote: `Adjusted ${signed(Number(a.qty))} — ${a.reason}`, resolvedById: ctx.user.id, resolvedAt: new Date() })
      .where(eq(erpStockCounts.id, a.count_id));
    return okVoid(`Posted ${signed(Number(a.qty))} of ${a.item} — ${countLabel(Number(a.count_no))} is resolved`);
  });
  if (res.ok) await erpAudit(ctx, decision === "approved" ? "erp.stockAdjustment.approve" : "erp.stockAdjustment.reject", "erp_stock_adjustment", id, null, { note });
  return res;
}

async function postAdjustment(tx: Tx, a: { id: string; rm: string; godown: string; qty: number; item: string; countNo: number; reason: string; byId: string }): Promise<{ transfers?: string[]; entry?: string }> {
  const lotsHere = (await rmLots(tx)).filter((l) => l.rawMaterialId === a.rm && l.godownId === a.godown);
  for (const l of lotsHere) {
    await lockLot(tx, "rm", l.lotNo, a.godown);
    await lockLot(tx, "Purchase", l.lotNo, a.godown);
  }
  const day = today();
  if (a.qty > 0) {
    const newest = [...lotsHere].sort((x, y) => y.latestDate.localeCompare(x.latestDate) || y.lotNo.localeCompare(x.lotNo))[0];
    const entry = erpId("rme");
    await tx.insert(erpRmEntries).values({ id: entry, sourceType: "adjustment", sourceId: a.id, entryDate: day, rawMaterialId: a.rm, lotNo: newest?.lotNo ?? `ADJ-${countLabel(a.countNo)}`, godownId: a.godown, quantity: r3(a.qty) });
    return { entry };
  }
  const [lost] = (await tx.execute(sql`select id from erp_godowns where reserved limit 1`)) as unknown as { id: string }[];
  if (!lost) return refuse(err("There is no Item Lost Record godown to write the shortage off to.", "rule_violation"));
  /* Read again under the locks: the stock to write off from is what is there now. */
  const fresh = (await rmLots(tx)).filter((l) => l.rawMaterialId === a.rm && l.godownId === a.godown && l.stock > 0).sort((x, y) => x.latestDate.localeCompare(y.latestDate) || x.lotNo.localeCompare(y.lotNo));
  let left = r3(-a.qty);
  const held = r3(fresh.reduce((t, l) => t + l.stock, 0));
  if (held + 1e-9 < left) return refuse(err(`The lots at this godown hold ${nf(held)}, less than the ${nf(left)} to write off. Stock is never taken below zero; check for a missing receipt first.`, "rule_violation"));
  const transfers: string[] = [];
  for (const l of fresh) {
    if (left <= 0.0005) break;
    const take = r3(Math.min(l.stock, left));
    const tid = erpId("TRF");
    const row = {
      id: tid,
      transferDate: day,
      itemType: "Purchase",
      fromGodownId: a.godown,
      toGodownId: lost.id,
      itemId: a.rm,
      itemName: a.item,
      lotNo: l.lotNo,
      quantity: take,
      remark: `Stock adjustment ${countLabel(a.countNo)} — ${a.reason}`,
      createdById: a.byId,
    };
    await tx.insert(erpTransfers).values(row);
    await tx.insert(erpRmEntries).values({ id: erpId("rme"), sourceType: "transfer", sourceId: tid, entryDate: day, rawMaterialId: a.rm, lotNo: l.lotNo, godownId: lost.id, quantity: take });
    transfers.push(tid);
    left = r3(left - take);
  }
  return { transfers };
}

/* ------------------------------------------------------- Missing records */

const missingRecordsScreen: ScreenModule = {
  key: "missingRecords",
  async load() {
    const rows = await missingRecords();
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "kind", l: "What is missing", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "detail", l: "Detail", t: "t", w: 420 },
    ];
    return {
      spec: {
        screen: "missingRecords",
        cols,
        hidden: [],
        groups: ["kind"],
        chips: "kind",
        godownKey: "godown",
        readOnly: true,
        sortDefault: ["date", -1],
        noDataLine: "No missing records. Every batch, fill, receipt and transfer has the stock entry it should.",
      },
      rows: rows.map(
        (m): ListRow => ({
          id: m.id,
          v: { date: m.date, kind: m.title, item: m.item, godown: m.godown, detail: m.detail },
          flags: [],
          title: m.title,
          header: `${m.item} · ${m.godown}`,
          fields: [
            { l: "What the system sees", v: m.detail },
            { l: "What is missing", v: "A record of the movement — the goods are where they are. Open the record, finish or correct it, and the stock entry follows. Nothing here is created for you." },
          ],
          actions: [{ id: "open", l: "Open the record", primary: true, href: erpLink(m.screen, { f: m.ids.join(","), fl: m.title }) }],
        }),
      ),
    };
  },
};

/* ------------------------------------------------------------ Every count */

const stockCounts: ScreenModule = {
  key: "stockCounts",
  async load() {
    const [rows, adjs] = await Promise.all([countRows(), adjustmentRows()]);
    const cols: ColSpec[] = [
      { k: "no", l: "Count", t: "mono" },
      { k: "date", l: "Counted", t: "d" },
      { k: "kind", l: "Kind", t: "s" },
      { k: "status", l: "Status", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "counted", l: "Counted", t: "n" },
      { k: "book", l: "Book", t: "n" },
      { k: "diff", l: "Difference", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "counter", l: "Counted by", t: "t" },
      { k: "resolution", l: "Resolution", t: "t" },
    ];
    return {
      spec: {
        screen: "stockCounts",
        cols,
        hidden: [],
        groups: ["kind"],
        chips: "status",
        godownKey: "godown",
        readOnly: true,
        sortDefault: ["no", -1],
        noDataLine: "No counts yet.",
      },
      rows: rows.map((c): ListRow => {
        const blind = c.status === "open";
        return {
          id: c.id,
          v: {
            no: countLabel(c.no),
            date: c.countedAt ? calendarDate(new Date(c.countedAt)) : null,
            kind: COUNT_KIND_LABEL[c.kind],
            status: COUNT_STATUS_LABEL[c.status],
            item: c.item,
            godown: c.godown,
            counted: c.counted,
            /* Never on an open count: the counter may be reading this list. */
            book: blind ? null : reconciledOf(c),
            diff: blind ? null : c.difference,
            unit: c.unit,
            counter: c.counter,
            resolution: c.resolution ? RESOLUTION_LABEL[c.resolution] : null,
          },
          flags: c.parent ? ["recount"] : [],
          title: `${countLabel(c.no)} · ${c.item}`,
          header: `${c.godown} · ${COUNT_KIND_LABEL[c.kind]} · ${c.reason}`,
          panel: c.parent ? undefined : panelFor(c, rows, null, adjs.find((a) => a.countId === c.id) ?? null),
          by: stampLine(c.createdBy, c.createdAt),
        };
      }),
    };
  },
};


/* ------------------------------------------------------------ Stock checks */

const CHECK_RESULT = { mismatch: "Mismatch", reviewed: "Mismatch · reviewed", matched: "Matched" } as const;
const resultOf = (c: FloorCheckRow) => (c.matched ? CHECK_RESULT.matched : c.reviewedAt ? CHECK_RESULT.reviewed : CHECK_RESULT.mismatch);
const STAGE_BY_LABEL = Object.fromEntries(Object.entries(STAGE_LABEL).map(([k, v]) => [v, k])) as Record<string, CheckStage>;

/**
 * STOCK CHECKS — anybody, any time, any kind of stock, from the factory phone
 * or from here. Blind like a count: the book is read when the figure arrives.
 * A mismatch waits here (and on the dashboard) until somebody who runs counts
 * has looked at it; a raw-material mismatch can be raised into a formal count,
 * whose red flag and approved adjustment are the only way the book moves.
 */
const floorChecks: ScreenModule = {
  key: "floorChecks",
  async load(ctx) {
    const [rows, gds] = await Promise.all([floorCheckRows(sql`f.counted_at > now() - interval '90 days'`, 2000), godownOptions(ctx, { lost: false })]);
    const items = gds.length ? await checkableItems(gds[0].id) : [];
    const byStage: Record<string, string[]> = {};
    for (const i of items) (byStage[STAGE_LABEL[i.stage]] ??= []).push(i.name);
    const cols: ColSpec[] = [
      { k: "item", l: "Item", t: "b" },
      { k: "result", l: "Result", t: "s" },
      { k: "date", l: "Checked", t: "d" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "counted", l: "Counted", t: "n" },
      { k: "book", l: "Book", t: "n" },
      { k: "diff", l: "Difference", t: "n" },
      { k: "reason", l: "Their reason", t: "t", w: 220 },
      { k: "counter", l: "Checked by", t: "t" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "kind", l: "Kind", t: "t" },
      { k: "from", l: "From", t: "t" },
    ];
    const header: FieldSpec[] = [
      { k: "kind", l: "Kind of stock", t: "select", req: true, opts: Object.values(STAGE_LABEL), def: STAGE_LABEL.rm },
      { k: "item", l: "Item", t: "select", req: true, optsBy: { by: "kind", map: byStage } },
      { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name), def: ctx.workingGodown?.name },
      { k: "qty", l: "Counted", t: "num", req: true, min: 0, hint: "The book is shown only after you save." },
      { k: "bin", l: "Where", t: "text", hint: "Bay, rack or bin." },
      { k: "reason", l: "If it differs, why (optional)", t: "area", mic: true },
    ];
    return {
      spec: {
        screen: "floorChecks",
        cols,
        hidden: [],
        groups: ["result", "godown"],
        chips: "result",
        godownKey: "godown",
        sortDefault: ["date", -1],
        newForm: { screen: "floorChecks", id: "new", title: "Record a stock check", sub: "Count any item at a godown. The figure is compared with the book the moment it is saved; a mismatch lands here and on the dashboard.", submit: "Save check", header },
        newLabel: "Record a stock check",
        noDataLine: "No stock checks in the last 90 days. The floor records them from the factory app (Stock check), and anybody here can record one.",
      },
      rows: rows.map((c): ListRow => {
        const result = resultOf(c);
        const actions: ActionSpec[] = [];
        if (!c.matched && !c.reviewedAt && runsCounts(ctx)) {
          actions.push({ id: "review", l: "Mark reviewed", primary: true, prompt: { title: "Mark this mismatch reviewed", sub: `${c.item} at ${c.godown}: counted ${nf(c.counted)}, book ${nf(c.book)} ${c.unit}`, submit: "Mark reviewed", fields: [{ k: "note", l: "What you found or did", t: "area", mic: true }] } });
          if (c.stage === "rm" && !c.stockCountId)
            actions.push({ id: "escalate", l: "Open a formal count", prompt: { title: "Open a formal count", sub: "A blind count of this item at this godown, with the red flag, recount and approved adjustment that come with it. The check is marked reviewed.", submit: "Open count", fields: [] } });
        }
        return {
          id: c.id,
          v: {
            date: calendarDate(new Date(c.countedAt)),
            result,
            kind: STAGE_LABEL[c.stage],
            item: c.item,
            godown: c.godown,
            counted: c.counted,
            book: c.book,
            diff: c.difference,
            unit: c.unit,
            reason: c.reason,
            counter: c.counter,
            from: c.source === "factory" ? "Factory app" : "ERP",
          },
          /* The Result column already says it; a flag would only repeat it. */
          flags: [],
          title: `${c.item} · ${c.godown}`,
          header: `${STAGE_LABEL[c.stage]} · ${result}${c.bin ? ` · ${c.bin}` : ""}`,
          fields: [
            { l: "Counted", v: `${nf(c.counted)} ${c.unit}` },
            { l: "Book when checked", v: `${nf(c.book)} ${c.unit}` },
            { l: "Difference", v: `${c.difference > 0 ? "+" : ""}${nf(c.difference)} ${c.unit} (tolerance ${nf(c.tolerance)})` },
            ...(c.reason ? [{ l: "Their reason", v: c.reason }] : []),
            ...(c.reviewedAt ? [{ l: "Reviewed", v: `${c.reviewer ?? ""}${c.reviewNote ? ` — ${c.reviewNote}` : ""}` }] : []),
            ...(c.stockCountNo ? [{ l: "Formal count", v: countLabel(c.stockCountNo) }] : []),
          ],
          actions,
          by: stampLine(c.counter, c.countedAt),
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const stage = STAGE_BY_LABEL[text(h.kind) ?? ""];
      if (!stage) return fieldErr("kind", "Pick the kind of stock");
      const gds = await godownOptions(ctx, { lost: false });
      const g = gds.find((x) => x.name === text(h.godown));
      if (!g) return fieldErr("godown", "Pick the godown");
      const item = (await checkableItems(g.id)).find((i) => i.stage === stage && i.name === text(h.item));
      if (!item) return fieldErr("item", "Pick the item");
      const qty = num(h.qty);
      if (qty == null || qty < 0) return fieldErr("qty", "Enter what you counted — zero if there is none");
      const r = await recordFloorCheck(ctx.user.id, { stage, itemId: item.id, godownId: g.id, qty, bin: text(h.bin), reason: text(h.reason), source: "erp" });
      if (!r.ok) return fieldErr(r.field, r.error);
      const c = r.check;
      await erpAudit(ctx, "erp.floorCheck.record", "erp_floor_check", c.id, null, { item: c.item, godown: c.godown, counted: c.counted, matched: c.matched });
      return okVoid(c.matched ? `Matches the book: counted ${nf(c.counted)}, book ${nf(c.book)} ${c.unit}` : `Mismatch: counted ${nf(c.counted)}, book ${nf(c.book)} ${c.unit} (${c.difference > 0 ? "+" : ""}${nf(c.difference)})`);
    },
  },
  actions: {
    async review(ctx, id, v) {
      if (!runsCounts(ctx)) return err("A manager or somebody who controls stock accuracy reviews a mismatch.", "not_permitted");
      const r = (await db.execute(sql`
        update erp_floor_checks set reviewed_by_id = ${ctx.user.id}, reviewed_at = now(), review_note = ${text(v.note)}
         where id = ${id} and not matched and reviewed_at is null returning id`)) as unknown as { id: string }[];
      if (!r.length) return err("That check has already been reviewed.", "conflict");
      await erpAudit(ctx, "erp.floorCheck.review", "erp_floor_check", id, null, { note: text(v.note) });
      return okVoid("Marked reviewed");
    },
    async escalate(ctx, id) {
      if (!runsCounts(ctx)) return err("A manager or somebody who controls stock accuracy opens counts.", "not_permitted");
      const [c] = await floorCheckRows(sql`f.id = ${id}`, 1);
      if (!c || c.stage !== "rm" || c.matched || c.stockCountId) return err("Only an unresolved raw-material mismatch is raised into a formal count.", "conflict");
      const opened = await db.transaction(async (tx) => {
        const o = await openCount(tx, { kind: "event", rawMaterialId: c.itemId, godownId: c.godownId, reason: `Stock check by ${c.counter} found ${c.difference > 0 ? "+" : ""}${nf(c.difference)} ${c.unit}${c.reason ? ` — "${c.reason}"` : ""}`, byId: ctx.user.id });
        await tx.execute(sql`update erp_floor_checks set stock_count_id = ${o.id}, reviewed_by_id = ${ctx.user.id}, reviewed_at = now(), review_note = coalesce(review_note, ${`Raised into ${countLabel(o.countNo)}`}) where id = ${id}`);
        return o;
      });
      await erpAudit(ctx, "erp.floorCheck.escalate", "erp_floor_check", id, null, { count: opened.id });
      return okVoid(opened.created ? `${countLabel(opened.countNo)} opened` : `${countLabel(opened.countNo)} was already open for that shelf — linked to it`);
    },
  },
};

export const STOCK_CHECK_SCREENS: ScreenModule[] = [countTasks, floorChecks, stockFlags, stockAdjustments, missingRecordsScreen, stockCounts];

/* -------------------------------------------- requirements, from outside */

/**
 * Opens the reorder counts for requirements just raised, inside the raise's
 * own transaction — the requirement and the count it waits on are one act.
 */
export async function openRequirementCounts(tx: Tx, reqs: { id: string; rawMaterialId: string | null; godownId: string; label: string }[], byId: string): Promise<void> {
  for (const r of reqs) {
    if (!r.rawMaterialId) continue;
    await openCount(tx, { kind: "reorder", rawMaterialId: r.rawMaterialId, godownId: r.godownId, requisitionId: r.id, reason: `Before purchase — ${r.label}`, byId });
  }
}

/** Marks a requirement's quantity confirmed, with the reason a person gave. */
export async function confirmRequirementQty(ctx: ErpContext, id: string, note: string): Promise<Result<unknown>> {
  await db.update(erpRequisitions).set({ qtyConfirmNote: note, qtyConfirmedById: ctx.user.id, qtyConfirmedAt: new Date() }).where(eq(erpRequisitions.id, id));
  await erpAudit(ctx, "erp.requisition.qtyConfirm", "erp_requisition", id, null, { note });
  return okVoid("Quantity confirmed — the purchase continues");
}
