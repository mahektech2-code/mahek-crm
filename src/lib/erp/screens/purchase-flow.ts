import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  erpFgLevels,
  erpGodowns,
  erpPoLines,
  erpProductPacking,
  erpPurchaseOrders,
  erpQuotations,
  erpRawMaterials,
  erpRequisitions,
  erpRmLevels,
  erpSuppliers,
  products,
  users,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { refValues } from "../refs";
import { DEPARTMENT_LABELS, categoriesFor, departmentsOf, requirementRefusal, requirementVisibleTo } from "../departments";
import { erpLink } from "../registry";
import { erpAudit, erpId, nextNumber, num, paise, rupeesField, stampLine, text, visibleCols, withoutHidden, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FormSpec, ListRow, ToolResult } from "../ui";
import { fd, inr, inrRate, nf } from "../ui";
import {
  FLOW_STEPS,
  LIVE_PO,
  PURCHASE_METHODS,
  RECEIVABLE_PO,
  methodByLabel,
  methodLabel,
  poLabel,
  poLineFigures,
  poMessage,
  poStatusAfterReceipt,
  poTotals,
  purchaseUnit,
  quoteExpired,
  rankQuotes,
  requirementStage,
  type PurchaseMethod,
  type Stage,
} from "../engines/purchase-flow";
import { fgLevelAvailable, rmLevelAvailable, rmLots } from "../stock";
import { bindErpFiles } from "../attachments";
import { dutyKit, type DutyKit } from "../material-duties-server";
import { godownIdByName, godownOptions, has, inTx, materials, refuse, today, type Col, type Tx } from "./common";

/* ---------------------------------------------------------------------------
 * THE PURCHASE FLOW'S FIRST FOUR STEPS (docs: AGENTS.md, "The purchase flow"):
 *
 *   Requirement → Purchase method → Vendor / quotation → Approval → PO → Receipt
 *
 * Requirements (`requisitions`) and their Quotations tab, and Purchase orders.
 * The receipt is goods inward and the register (`purchase.ts`), which refuse
 * anything that does not name an approved PO's line.
 *
 * Every step is decided by the server from the requirement's own record — the
 * method from the item's purchase rule copied on raise, the vendor from a
 * direct choice or a selected quotation, the PO from the requirement it names
 * — and a step that is not available yet says why, rather than being hidden.
 * ------------------------------------------------------------------------- */

const MONEY_WHY = "Purchase money is not on your account";

/* ======================================================== reading the flow */

type Req = typeof erpRequisitions.$inferSelect;
type Quote = typeof erpQuotations.$inferSelect & { supplier: string };

export type ReqView = {
  r: Req;
  godown: string;
  item: string;
  itemType: string;
  itemUnit: string;
  /** The rule in force: the one copied on raise, or the item's own for a requirement from before rules. */
  rule: PurchaseMethod;
  /** How it is being bought: stored, or — for a requirement from before rules — the item's rule where it is not the buyer's. */
  method: "direct" | "quotation" | null;
  preferredSupplierId: string | null;
  supplier: string | null;
  quotes: Quote[];
  selected: Quote | null;
  po: { id: string; number: number; status: string; lineId: string; ordered: number; received: number } | null;
  legacy: boolean;
  by: string | null;
};

/**
 * What has been received against each PO line: inward lines (the gate) and
 * register rows entered by hand against the line. Never stored, so a receipt
 * moves the PO with nothing to rebuild.
 */
export async function receivedByLine(tx: Tx | typeof db = db): Promise<Map<string, number>> {
  const rows = (await tx.execute(sql`
    select line, sum(q)::float8 as q from (
      select po_line_id as line, quantity as q from erp_inward where po_line_id is not null
      union all
      select po_line_id, quantity from erp_purchases where po_line_id is not null and source = 'manual'
    ) x group by line
  `)) as unknown as { line: string; q: number }[];
  return new Map(rows.map((r) => [r.line, Number(r.q)]));
}

export async function requirementViews(where?: { ids?: string[] }): Promise<ReqView[]> {
  const rows = await db
    .select({
      r: erpRequisitions,
      godown: erpGodowns.name,
      item: sql<string>`coalesce(${erpRawMaterials.name}, ${products.name})`,
      itemType: sql<string>`coalesce(${erpRawMaterials.materialType}, ${erpRequisitions.materialType})`,
      itemUnit: sql<string>`coalesce(${erpRawMaterials.unit}, ${erpRequisitions.unit})`,
      itemRule: sql<string>`coalesce(${erpRawMaterials.purchaseMethod}, 'direct')`,
      preferred: erpRawMaterials.preferredSupplierId,
      supplier: erpSuppliers.name,
      by: users.name,
    })
    .from(erpRequisitions)
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpRequisitions.godownId))
    .leftJoin(erpRawMaterials, eq(erpRawMaterials.id, erpRequisitions.rawMaterialId))
    .leftJoin(products, eq(products.id, erpRequisitions.productId))
    .leftJoin(erpSuppliers, eq(erpSuppliers.id, erpRequisitions.supplierId))
    .leftJoin(users, eq(users.id, erpRequisitions.createdById))
    .where(where?.ids ? inArray(erpRequisitions.id, where.ids.length ? where.ids : ["-"]) : undefined)
    .orderBy(asc(erpRequisitions.reqDate), asc(erpRequisitions.createdAt), asc(erpRequisitions.id));
  const ids = rows.map((x) => x.r.id);
  const [quotes, lines, received] = await Promise.all([
    ids.length
      ? db
          .select({ q: erpQuotations, supplier: erpSuppliers.name })
          .from(erpQuotations)
          .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpQuotations.supplierId))
          .where(inArray(erpQuotations.requisitionId, ids))
      : Promise.resolve([]),
    ids.length
      ? db
          .select({ l: erpPoLines, number: erpPurchaseOrders.poNumber, status: erpPurchaseOrders.status, createdAt: erpPurchaseOrders.createdAt })
          .from(erpPoLines)
          .innerJoin(erpPurchaseOrders, eq(erpPurchaseOrders.id, erpPoLines.poId))
          .where(and(inArray(erpPoLines.requisitionId, ids), inArray(erpPurchaseOrders.status, LIVE_PO)))
      : Promise.resolve([]),
    receivedByLine(),
  ]);
  const quotesOf = new Map<string, Quote[]>();
  quotes.forEach((x) => (quotesOf.get(x.q.requisitionId) ?? quotesOf.set(x.q.requisitionId, []).get(x.q.requisitionId)!).push({ ...x.q, supplier: x.supplier }));
  const poOf = new Map<string, ReqView["po"]>();
  lines
    .sort((a, b) => +a.createdAt - +b.createdAt)
    .forEach((x) =>
      poOf.set(x.l.requisitionId, { id: x.l.poId, number: x.number, status: x.status, lineId: x.l.id, ordered: x.l.quantity, received: received.get(x.l.id) ?? 0 }),
    );
  return rows.map((x) => {
    const rule = (x.r.purchaseRule ?? x.itemRule) as PurchaseMethod;
    /* From before the rule and already ordered the old way — or a finished good, which is made, never bought. */
    const legacy = (!x.r.purchaseRule && !poOf.get(x.r.id) && ["Order Placed", "Booked", "Received"].includes(x.r.status)) || !!x.r.productId;
    const method = (x.r.method ?? (rule !== "buyer" ? rule : null)) as ReqView["method"];
    const q = quotesOf.get(x.r.id) ?? [];
    return {
      r: x.r,
      godown: x.godown,
      item: x.item,
      itemType: x.itemType,
      itemUnit: x.itemUnit,
      rule,
      method,
      preferredSupplierId: x.preferred,
      supplier: x.supplier,
      quotes: q,
      selected: q.find((y) => y.id === x.r.quotationId) ?? null,
      po: poOf.get(x.r.id) ?? null,
      legacy,
      by: x.by,
    };
  });
}

export function stageOf(v: ReqView, minQuotations: number): Stage {
  return requirementStage({
    status: v.r.status,
    rule: v.rule,
    method: v.method,
    supplierId: v.r.supplierId,
    quotationId: v.r.quotationId,
    quoteCount: v.quotes.length,
    minQuotations,
    po: v.po ? { status: v.po.status, ordered: v.po.ordered, received: v.po.received } : null,
    legacy: v.legacy,
  });
}

/** Requirement ids by the work waiting on them — the dashboard tiles and the sidebar badge read these. */
export async function requirementWork(ctx?: Pick<ErpContext, "department" | "user">): Promise<Record<string, { id: string; godown: string }[]>> {
  const [views, config] = await Promise.all([requirementViews(), getConfig()]);
  const out: Record<string, { id: string; godown: string }[]> = {};
  /* A departmental person counts only the requirements on their own list. */
  for (const v of views.filter((x) => !ctx || requirementVisibleTo(ctx.department, x.r.department, x.r.createdById === ctx.user.id))) {
    const s = stageOf(v, config["erp.purchase.minQuotations"]).stage;
    (out[s] ??= []).push({ id: v.r.id, godown: v.godown });
  }
  return out;
}

/** Stages somebody has to act on before a PO exists. */
export const REQUIREMENT_ACTION_STAGES = ["Buyer decision", "Select vendor", "Collect quotations", "Compare quotations", "Ready for PO"];

/* -------------------------------------------------------------- the POs */

export type PoLineView = typeof erpPoLines.$inferSelect & { item: string; itemType: string; received: number; label: string; requirementGodown: string };
export type PoView = {
  po: typeof erpPurchaseOrders.$inferSelect;
  supplier: string;
  supplierPhone: string | null;
  supplierEmail: string | null;
  godown: string;
  by: string | null;
  approver: string | null;
  lines: PoLineView[];
};

export function poOption(p: { po: { poNumber: number }; supplier: string }): string {
  return `${poLabel(p.po.poNumber)} · ${p.supplier}`;
}

export async function purchaseOrderViews(where?: { ids?: string[]; status?: string[] }): Promise<PoView[]> {
  const approver = sql<string | null>`(select name from users u2 where u2.id = ${erpPurchaseOrders.approvedById})`;
  const conds = [
    where?.ids ? inArray(erpPurchaseOrders.id, where.ids.length ? where.ids : ["-"]) : undefined,
    where?.status ? inArray(erpPurchaseOrders.status, where.status) : undefined,
  ].filter(Boolean);
  const rows = await db
    .select({
      po: erpPurchaseOrders,
      supplier: erpSuppliers.name,
      phone: sql<string | null>`coalesce(${erpSuppliers.whatsapp}, ${erpSuppliers.mobile})`,
      email: erpSuppliers.email,
      godown: erpGodowns.name,
      by: users.name,
      approver,
    })
    .from(erpPurchaseOrders)
    .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpPurchaseOrders.supplierId))
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpPurchaseOrders.godownId))
    .leftJoin(users, eq(users.id, erpPurchaseOrders.createdById))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`${erpPurchaseOrders.poNumber} desc`);
  const ids = rows.map((r) => r.po.id);
  const [lines, received] = await Promise.all([
    ids.length
      ? db
          .select({ l: erpPoLines, item: erpRawMaterials.name, itemType: erpRawMaterials.materialType, godown: erpGodowns.name })
          .from(erpPoLines)
          .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpPoLines.rawMaterialId))
          .innerJoin(erpRequisitions, eq(erpRequisitions.id, erpPoLines.requisitionId))
          .innerJoin(erpGodowns, eq(erpGodowns.id, erpRequisitions.godownId))
          .where(inArray(erpPoLines.poId, ids))
          .orderBy(asc(erpPoLines.sortOrder))
      : Promise.resolve([]),
    receivedByLine(),
  ]);
  const byPo = new Map<string, PoLineView[]>();
  lines.forEach((x) => {
    const list = byPo.get(x.l.poId) ?? byPo.set(x.l.poId, []).get(x.l.poId)!;
    list.push({ ...x.l, item: x.item, itemType: x.itemType, received: received.get(x.l.id) ?? 0, label: `${list.length + 1}. ${x.item}`, requirementGodown: x.godown });
  });
  return rows.map((r) => ({
    po: r.po,
    supplier: r.supplier,
    supplierPhone: r.phone,
    supplierEmail: r.email,
    godown: r.godown,
    by: r.by,
    approver: r.approver,
    lines: byPo.get(r.po.id) ?? [],
  }));
}

/**
 * After anything that receives goods against a PO: the PO's receiving status
 * and its requirements' status, rewritten from what has arrived. Inside the
 * caller's transaction, so a receipt and its consequences land together.
 */
export async function refreshPurchaseOrder(tx: Tx, poId: string | null | undefined): Promise<void> {
  if (!poId) return;
  const [po] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, poId));
  if (!po) return;
  const lines = await tx.select().from(erpPoLines).where(eq(erpPoLines.poId, poId));
  const received = await receivedByLine(tx);
  const state = lines.map((l) => ({ id: l.id, req: l.requisitionId, ordered: l.quantity, received: received.get(l.id) ?? 0 }));
  const status = poStatusAfterReceipt(po.status, state);
  if (status !== po.status) await tx.update(erpPurchaseOrders).set({ status, updatedAt: new Date() }).where(eq(erpPurchaseOrders.id, poId));
  if (!["Approved", "Sent", "Partly received", "Received"].includes(status)) return;
  for (const l of state) {
    const st = l.received >= l.ordered ? "Received" : "Order Placed";
    await tx.update(erpRequisitions).set({ status: st, updatedAt: new Date() }).where(eq(erpRequisitions.id, l.req));
  }
}

/* ========================================================== requirements */

/**
 * A requirement's present quantity (spec §5.2): what the godown's re-order
 * level counts as available for the item — the same figure the levels screen
 * shows. Blank where no level is set there (§14 A-04), said in words.
 */
async function presentQuantities() {
  const [rmLevels, fgLevels, rmAvail, fgAvail, packing] = await Promise.all([
    db.select().from(erpRmLevels),
    db.select().from(erpFgLevels),
    rmLevelAvailable(),
    fgLevelAvailable(),
    db.select({ id: erpProductPacking.productId, empty: erpProductPacking.emptyBoxesRequired }).from(erpProductPacking),
  ]);
  const rm = new Map(rmLevels.map((l) => [`${l.rawMaterialId}|${l.godownId}`, l.materialType]));
  const fg = new Set(fgLevels.map((l) => `${l.productId}|${l.godownId}`));
  const boxed = new Map(packing.map((p) => [p.id, (p.empty ?? 0) > 0]));
  return (r: Req): string | number => {
    if (r.productId) {
      if (!fg.has(`${r.productId}|${r.godownId}`)) return "no level set";
      return fgAvail(r.productId, boxed.get(r.productId) ?? false, r.godownId);
    }
    if (!r.rawMaterialId) return "—";
    const type = rm.get(`${r.rawMaterialId}|${r.godownId}`);
    if (!type) return "no level set";
    return rmAvail(type, r.rawMaterialId, r.godownId);
  };
}

/**
 * The requirement form. The item's purchase rule is shown as it is picked —
 * "Check purchase rule" is a step of the flow, so the person raising it sees
 * where it will go before they raise it.
 */
export async function requisitionForm(ctx: ErpContext, init?: Record<string, string>, editing?: ReqView, kit?: DutyKit): Promise<FormSpec> {
  const duties = kit ?? (await dutyKit(ctx));
  const [allMats, gds, rm, allTypes, deptList, sups] = await Promise.all([
    materials(),
    godownOptions(ctx, { lost: false }),
    rmLots(),
    refValues("materialType"),
    refValues("department"),
    db.select({ id: erpSuppliers.id, name: erpSuppliers.name }).from(erpSuppliers),
  ]);
  const supName = new Map(sups.map((s) => [s.id, s.name]));
  /* Only what this person may ask for (`material-duties.ts`); a category with
     nothing left in it is not offered, so the form never opens onto an empty list. */
  const mats = allMats.filter((m) => duties.allows(m.id, "request") || m.id === editing?.r.rawMaterialId);
  const types = allTypes.filter((t) => mats.some((m) => m.materialType === t));
  /* A production department asks for its own categories; somebody in one
     raises for their own department(s) only (`lib/erp/departments.ts`). */
  const mine = departmentsOf(ctx.department);
  const departments = mine.length ? mine.map((d) => d.label) : [...new Set([...DEPARTMENT_LABELS, ...deptList])];
  const typesBy: Record<string, string[]> = Object.fromEntries(departments.map((d) => [d, categoriesFor(d, types)]));
  const map: Record<string, string[]> = {};
  const unitOf: Record<string, string> = {};
  const ruleOf: Record<string, string> = {};
  for (const m of mats) {
    (map[m.materialType] ??= []).push(m.name);
    unitOf[m.name] = purchaseUnit(m.unit, m.materialType);
    const rule = m.purchaseMethod as PurchaseMethod;
    const vendor = m.preferredSupplierId ? supName.get(m.preferredSupplierId) : null;
    ruleOf[m.name] =
      rule === "direct"
        ? `Direct purchase${vendor ? ` · ${vendor} is offered as the vendor` : " · a vendor is chosen next"}`
        : rule === "quotation"
          ? "Quotation required · quotations are collected and compared before the PO"
          : "Buyer decision · the buyer chooses direct purchase or quotations";
  }
  const stockOf: Record<string, { lot: string; godown: string; qty: number; unit: string }[]> = {};
  rm.filter((l) => l.stock > 0).forEach((l) => (stockOf[l.item] ??= []).push({ lot: l.lotNo, godown: l.godown, qty: l.stock, unit: l.unit }));
  const r = editing?.r;
  return {
    screen: "requisitions",
    id: editing ? "edit" : "new",
    recordId: r?.id,
    title: editing ? `Edit requirement · ${editing.item}` : "New purchase requirement",
    sub: editing ? "The item and its purchase rule are fixed once raised; everything else can change until it is on a PO." : "Step 1 of the purchase flow. The item's purchase rule decides what happens next.",
    submit: editing ? "Save requirement" : "Raise requirement",
    init: editing
      ? {
          date: r!.reqDate,
          requiredBy: r!.requiredBy ?? "",
          department: r!.department ?? "",
          godown: editing.godown,
          type: editing.itemType,
          item: editing.item,
          required: String(r!.requiredQty),
          priority: r!.priority,
          remarks: r!.remarks ?? "",
        }
      : { date: today(), godown: ctx.workingGodown?.name ?? "", priority: "Medium", ...(mine.length === 1 ? { department: mine[0].label } : {}), ...init },
    data: { stockOf, unitOf, ruleOf },
    header: [
      { k: "date", l: "Date", t: "date", req: true, sec: "Requirement" },
      { k: "requiredBy", l: "Required by", t: "date", req: true, hint: "The date the department needs the goods in hand." },
      {
        k: "department",
        l: "Department",
        t: "select",
        req: true,
        opts: departments,
        readOnly: !editing && mine.length === 1,
        hint: mine.length ? `You raise requirements for ${mine.map((d) => `${d.label} (${d.materialTypes.join(", ").toLowerCase()})`).join(" · ")}.` : undefined,
      },
      { k: "godown", l: "Deliver to godown", t: "select", req: true, opts: gds.map((g) => g.name) },
      { k: "type", l: "Category", t: "select", req: true, optsBy: { by: "department", map: typesBy }, when: { k: "department", notEmpty: true }, readOnly: !!editing },
      { k: "item", l: "Item", t: "select", req: true, optsBy: { by: "type", map }, when: { k: "type", notEmpty: true }, readOnly: !!editing },
      { k: "rule", l: "Purchase rule", t: "derived", calc: "requisitions.rule", when: { k: "item", notEmpty: true } },
      { k: "onHand", l: "Available stock", t: "derived", calc: "requisitions.onHand", when: { k: "item", notEmpty: true } },
      { k: "required", l: "Quantity", t: "num", req: true, min: 0.001 },
      { k: "unit", l: "Unit", t: "derived", calc: "requisitions.unit" },
      { k: "priority", l: "Priority", t: "select", req: true, opts: ["Urgent", "Medium", "For Stock"] },
      { k: "remarks", l: "Remarks", t: "area", mic: true },
    ],
  };
}

function quoteOptionLabel(q: Quote & { fig: { landedPaise: number }; lowest: boolean; expired: boolean }): string {
  return `${q.supplier} · ${inr(q.fig.landedPaise)} landed${q.lowest ? " · lowest" : ""}${q.expired ? " · expired" : ""}`;
}

function flowPanel(v: ReqView, st: Stage, money: boolean, minQuotations: number) {
  const ranked = rankQuotes(v.quotes, v.r.requiredQty, today());
  return {
    kind: "purchaseFlow",
    data: {
      steps: FLOW_STEPS,
      step: st.step,
      stage: st.stage,
      next: st.next,
      facts: [
        { l: "Purchase rule", v: methodLabel(v.rule) },
        { l: "Method", v: v.method ? methodLabel(v.method) : "Waiting for the buyer" },
        ...(v.r.methodNote ? [{ l: "Buyer's note", v: v.r.methodNote }] : []),
        { l: "Vendor", v: v.supplier ?? "Not chosen yet" },
        ...(v.r.selectionNote ? [{ l: "Why this quotation", v: v.r.selectionNote }] : []),
        ...(v.po ? [{ l: "Purchase order", v: `${poLabel(v.po.number)} · ${v.po.status}`, href: erpLink("purchaseOrders", { open: v.po.id }) }] : []),
        ...(v.po ? [{ l: "Received", v: `${nf(v.po.received)} of ${nf(v.po.ordered)} ${v.r.unit}` }] : []),
        ...(v.r.cancelReason ? [{ l: "Cancelled because", v: v.r.cancelReason }] : []),
      ],
      quotes:
        v.method === "quotation" || v.quotes.length
          ? {
              min: minQuotations,
              money,
              rows: ranked.map((q) => ({
                vendor: q.supplier,
                rate: money ? inrRate(q.ratePaise) : null,
                gst: `${q.gstBp / 100}%`,
                freight: money ? inr(q.freightPaise) : null,
                landed: money ? inr(q.fig.landedPaise) : null,
                delivery: q.deliveryDays == null ? "—" : `${q.deliveryDays} days`,
                terms: q.paymentTerms ?? "—",
                validUntil: q.validUntil ? fd(q.validUntil) : "—",
                lowest: q.lowest,
                expired: q.expired,
                selected: q.id === v.r.quotationId,
                document: q.documentId,
              })),
            }
          : null,
    },
  };
}

const requisitions: ScreenModule = {
  key: "requisitions",
  async load(ctx) {
    const kit = await dutyKit(ctx);
    const [views, config, form, present] = await Promise.all([requirementViews(), getConfig(), requisitionForm(ctx, undefined, undefined, kit), presentQuantities()]);
    const min = config["erp.purchase.minQuotations"];
    const money = ctx.powers.has("viewPurchaseMoney");
    const buyer = ctx.powers.has("purchaseBuyer");
    const poScreen = ctx.screens.has("purchaseOrders");
    const day = today();
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "item", l: "Item", t: "b" },
      { k: "type", l: "Category", t: "s" },
      { k: "required", l: "Quantity", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "present", l: "Present qty", t: "n" },
      { k: "requiredBy", l: "Required by", t: "d" },
      { k: "department", l: "Department", t: "t" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "priority", l: "Priority", t: "s" },
      { k: "method", l: "Method", t: "s" },
      { k: "stage", l: "Stage", t: "s" },
      { k: "vendor", l: "Vendor", t: "t" },
      { k: "po", l: "PO", t: "mono" },
      { k: "remarks", l: "Remarks", t: "t" },
      { k: "f", l: "Flags", t: "f" },
    ];
    const out: ListRow[] = views
      .filter((v) => requirementVisibleTo(ctx.department, v.r.department, v.r.createdById === ctx.user.id))
      .slice()
      .reverse()
      .map((v) => {
        const st = stageOf(v, min);
        const r = v.r;
        const actions: ActionSpec[] = [];
        const mat = { id: r.rawMaterialId ?? "", name: v.item };
        const mayRequest = !r.rawMaterialId || kit.allows(r.rawMaterialId, "request");
        const mayRaisePo = !r.rawMaterialId || kit.allows(r.rawMaterialId, "raisePo");
        const open = st.step >= 0 && !v.po && !v.legacy;
        if (st.stage === "Buyer decision")
          actions.push({
            id: "decide",
            l: "Decide method",
            primary: true,
            why: buyer ? "" : "Only the buyer decides how this is bought",
            prompt: {
              title: "Buyer decision",
              sub: `${v.item} · ${nf(r.requiredQty)} ${r.unit}. Direct purchase picks the vendor; quotation collects and compares quotations first.`,
              submit: "Save decision",
              fields: [
                { k: "method", l: "Buy by", t: "select", req: true, opts: PURCHASE_METHODS.filter((m) => m.v !== "buyer").map((m) => m.label) },
                { k: "note", l: "Why", t: "area", hint: "What made this an exception — read by whoever picks it up next." },
              ],
            },
          });
        if (open && v.method === "direct")
          actions.push({
            id: "vendor",
            l: v.r.supplierId ? "Change vendor" : "Select vendor",
            primary: !v.r.supplierId,
            prompt: {
              title: v.r.supplierId ? "Change vendor" : "Select vendor",
              sub: `${v.item} · direct purchase. The PO is raised to this vendor.`,
              submit: "Save vendor",
              fields: [{ k: "vendor", l: "Vendor", t: "select", req: true, opts: [] }],
              init: { vendor: v.supplier ?? "" },
            },
          });
        if (open && v.method === "quotation") {
          actions.push({ id: "addQuote", l: "Add quotation", loadsForm: true, primary: st.stage === "Collect quotations", why: money ? "" : MONEY_WHY });
          const ranked = rankQuotes(v.quotes, r.requiredQty, day);
          actions.push({
            id: "selectQuote",
            l: v.r.quotationId ? "Change quotation" : "Compare & select",
            primary: st.stage === "Compare quotations",
            why: !money ? MONEY_WHY : v.quotes.length < min ? `Needs at least ${min} quotation${min > 1 ? "s" : ""} — ${v.quotes.length} in` : "",
            prompt: money
              ? {
                  title: "Select a quotation",
                  sub: `${v.item} · ${nf(r.requiredQty)} ${r.unit}. Ranked by landed cost — rate, GST and freight. The open record shows them side by side.`,
                  submit: "Select",
                  fields: [
                    { k: "quote", l: "Quotation", t: "select", req: true, opts: ranked.filter((q) => !q.expired).map(quoteOptionLabel) },
                    { k: "note", l: "Why this one", t: "area", hint: "Required when it is not the lowest landed cost." },
                  ],
                  init: { quote: ranked.find((q) => q.id === v.r.quotationId) ? quoteOptionLabel(ranked.find((q) => q.id === v.r.quotationId)!) : "" },
                }
              : undefined,
          });
        }
        if (st.readyForPo)
          actions.unshift({
            id: "createPo",
            l: "Create PO",
            primary: true,
            loadsForm: true,
            why: !poScreen ? "Purchase orders is not on your account" : !money ? MONEY_WHY : mayRaisePo ? "" : (kit.refusal(mat, "raisePo") ?? ""),
          });
        if (v.po) actions.push({ id: "openPo", l: `Open ${poLabel(v.po.number)}`, href: erpLink("purchaseOrders", { open: v.po.id }) });
        if (open) actions.push({ id: "edit", l: "Edit", loadsForm: true, why: mayRequest ? "" : (kit.refusal(mat, "request") ?? "") });
        if (st.step >= 0 && st.step < FLOW_STEPS.length && (!v.po || v.legacy))
          actions.push({
            id: "cancel",
            l: "Cancel requirement",
            prompt: { title: "Cancel this requirement", sub: `${v.item} · ${nf(r.requiredQty)} ${r.unit}`, submit: "Cancel requirement", fields: [{ k: "reason", l: "Reason", t: "area", req: true }] },
          });
        else if (v.po && st.step >= 0 && st.step < FLOW_STEPS.length)
          actions.push({ id: "cancel", l: "Cancel requirement", why: `It is on ${poLabel(v.po.number)} — cancel or send back the PO first` });
        const flags: string[] = [];
        if (r.requiredBy && r.requiredBy < day && st.step >= 0 && st.step < FLOW_STEPS.length) flags.push("requiredOverdue");
        if (v.legacy) flags.push("noPo");
        return {
          id: r.id,
          v: {
            date: r.reqDate,
            item: v.item,
            type: r.materialType,
            required: r.requiredQty,
            unit: r.unit,
            present: present(r),
            requiredBy: r.requiredBy,
            department: r.department,
            godown: v.godown,
            priority: r.priority,
            method: v.method ? methodLabel(v.method) : methodLabel(v.rule),
            stage: st.stage,
            vendor: v.supplier,
            po: v.po ? poLabel(v.po.number) : null,
            remarks: r.remarks,
          },
          flags,
          title: v.item,
          header: `${nf(r.requiredQty)} ${r.unit} · ${v.godown}${r.department ? ` · ${r.department}` : ""} · ${st.next}`,
          actions,
          panel: flowPanel(v, st, money, min),
          by: stampLine(v.by, r.createdAt),
        };
      });
    /* The vendor prompt's options are the active suppliers — read once. */
    const sups = (await db.select({ name: erpSuppliers.name }).from(erpSuppliers).where(eq(erpSuppliers.active, true)).orderBy(asc(erpSuppliers.name))).map((s) => s.name);
    out.forEach((row) => row.actions?.forEach((a) => a.id === "vendor" && a.prompt && (a.prompt.fields[0].opts = sups)));
    return {
      spec: {
        screen: "requisitions",
        cols,
        hidden: [],
        groups: ["stage"],
        chips: "stage",
        godownKey: "godown",
        newForm: form,
        newLabel: "New requirement",
        noDataLine: "No purchase requirements yet.",
      },
      rows: out,
    };
  },
  formLoaders: {
    edit: async (ctx, id) => {
      const [v] = await requirementViews({ ids: [id] });
      return v ? requisitionForm(ctx, undefined, v) : null;
    },
    addQuote: (ctx, id) => quotationForm(ctx, { requisitionId: id }),
    createPo: async (ctx, id) => {
      const [v] = await requirementViews({ ids: [id] });
      if (!v?.r.supplierId) return null;
      return purchaseOrderForm(ctx, { supplierId: v.r.supplierId, focus: id });
    },
  },
  forms: {
    async new(ctx, h) {
      return saveRequirement(ctx, h);
    },
    async edit(ctx, h, _l, id) {
      return saveRequirement(ctx, h, id);
    },
  },
  actions: {
    async decide(ctx, id, values) {
      if (!ctx.powers.has("purchaseBuyer")) return err("Only the buyer decides how a requirement is bought.", "not_permitted");
      const m = methodByLabel(text(values.method));
      if (m !== "direct" && m !== "quotation") return fieldErr("method", "Choose direct purchase or quotation");
      const [v] = await requirementViews({ ids: [id] });
      if (!v) return err("That requirement no longer exists.", "not_found");
      const min = (await getConfig())["erp.purchase.minQuotations"];
      if (stageOf(v, min).stage !== "Buyer decision") return err("This requirement's method is already decided.", "conflict");
      const preset = m === "direct" && v.preferredSupplierId ? v.preferredSupplierId : null;
      await db
        .update(erpRequisitions)
        .set({
          method: m,
          methodDecidedById: ctx.user.id,
          methodDecidedAt: new Date(),
          methodNote: text(values.note),
          ...(preset ? { supplierId: preset, vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id } : {}),
          updatedAt: new Date(),
          updatedById: ctx.user.id,
        })
        .where(eq(erpRequisitions.id, id));
      await erpAudit(ctx, "erp.requisition.decideMethod", "erp_requisition", id, null, { method: m, note: text(values.note) });
      return okVoid(m === "direct" ? `Direct purchase${preset ? " · the item's default vendor is offered" : " · select the vendor next"}` : "Quotation · collect quotations next");
    },
    async vendor(ctx, id, values) {
      const [sup] = await db.select().from(erpSuppliers).where(and(eq(erpSuppliers.name, text(values.vendor) ?? ""), eq(erpSuppliers.active, true)));
      if (!sup) return fieldErr("vendor", "Pick an active vendor");
      const [v] = await requirementViews({ ids: [id] });
      if (!v) return err("That requirement no longer exists.", "not_found");
      if (v.r.status === "Cancelled") return err("This requirement is cancelled.", "conflict");
      if (v.po) return err(`It is on ${poLabel(v.po.number)} — the vendor is the PO's now.`, "conflict");
      if (v.method !== "direct") return err("Only a direct purchase has its vendor picked; a quotation's vendor is the selected quotation.", "rule_violation");
      await db
        .update(erpRequisitions)
        .set({ method: "direct", supplierId: sup.id, vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpRequisitions.id, id));
      await erpAudit(ctx, "erp.requisition.selectVendor", "erp_requisition", id, { supplierId: v.r.supplierId }, { supplierId: sup.id });
      return okVoid(`${sup.name} is the vendor · raise the PO next`);
    },
    async selectQuote(ctx, id, values) {
      const [v] = await requirementViews({ ids: [id] });
      if (!v) return err("That requirement no longer exists.", "not_found");
      const ranked = rankQuotes(v.quotes, v.r.requiredQty, today());
      const q = ranked.find((x) => quoteOptionLabel(x) === text(values.quote));
      if (!q) return fieldErr("quote", "Pick one of the quotations");
      return selectQuotation(ctx, q.id, text(values.note));
    },
    async cancel(ctx, id, values) {
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say why it is cancelled");
      const [v] = await requirementViews({ ids: [id] });
      if (!v) return err("That requirement no longer exists.", "not_found");
      if (!requirementVisibleTo(ctx.department, v.r.department, v.r.createdById === ctx.user.id)) return err("That requirement belongs to another department.", "not_permitted");
      if (v.r.status === "Cancelled") return err("Already cancelled.", "conflict");
      if (v.po) return err(`It is on ${poLabel(v.po.number)} — cancel or send back the PO first.`, "conflict");
      if (v.r.status === "Received") return err("It has been received.", "conflict");
      await db.update(erpRequisitions).set({ status: "Cancelled", cancelReason: reason, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpRequisitions.id, id));
      await erpAudit(ctx, "erp.requisition.cancel", "erp_requisition", id, { status: v.r.status }, { status: "Cancelled", reason });
      return okVoid("Requirement cancelled");
    },
  },
};

async function saveRequirement(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const requiredBy = text(h.requiredBy);
  if (!requiredBy) return fieldErr("requiredBy", "Required by is required");
  const date = text(h.date) ?? today();
  if (requiredBy < date) return fieldErr("requiredBy", "Required by cannot be before the requirement's date");
  const department = text(h.department);
  if (!department) return fieldErr("department", "Department is required");
  const qty = num(h.required);
  if (qty == null || qty <= 0) return fieldErr("required", qty != null && qty < 0 ? "Minus Quantity Not Allowed" : "Quantity is required");
  const priority = text(h.priority) ?? "Medium";
  if (!["Urgent", "Medium", "For Stock"].includes(priority)) return fieldErr("priority", "Priority is required");
  if (id) {
    const [v] = await requirementViews({ ids: [id] });
    if (!v) return err("That requirement no longer exists.", "not_found");
    if (v.po || v.legacy || v.r.status === "Cancelled") return err("A requirement on a PO, received or cancelled is not edited.", "conflict");
    if (!requirementVisibleTo(ctx.department, v.r.department, v.r.createdById === ctx.user.id)) return err("That requirement belongs to another department.", "not_permitted");
    if (v.r.rawMaterialId) {
      const duties = await dutyKit(ctx);
      if (!duties.allows(v.r.rawMaterialId, "request")) return err(`${duties.refusal({ id: v.r.rawMaterialId, name: v.item }, "request")}.`, "not_permitted");
    }
    const refusedEdit = requirementRefusal(ctx.department, department, v.itemType);
    if (refusedEdit) return fieldErr(refusedEdit.field, refusedEdit.message);
    const values = { reqDate: date, requiredBy, department, godownId, requiredQty: qty, priority, remarks: text(h.remarks), updatedAt: new Date(), updatedById: ctx.user.id };
    await db.update(erpRequisitions).set(values).where(eq(erpRequisitions.id, id));
    await erpAudit(ctx, "erp.requisition.edit", "erp_requisition", id, v.r, values);
    return okVoid("Requirement saved");
  }
  const type = text(h.type);
  /* Finished goods are made, not bought: only the item master's categories may be asked for. */
  if (!type || !(await refValues("materialType")).includes(type)) return fieldErr("type", "Category is required");
  const refused = requirementRefusal(ctx.department, department, type);
  if (refused) return fieldErr(refused.field, refused.message);
  const item = text(h.item);
  if (!item) return fieldErr("item", "Item is required");
  const [m] = await db
    .select()
    .from(erpRawMaterials)
    .where(and(eq(erpRawMaterials.name, item), eq(erpRawMaterials.materialType, type), eq(erpRawMaterials.active, true)));
  if (!m) return fieldErr("item", "Pick an item of this category");
  const duties = await dutyKit(ctx);
  if (!duties.allows(m.id, "request")) return fieldErr("item", `${duties.refusal(m, "request") ?? "You may not request this item"}.`);
  /* CHECK PURCHASE RULE: copied onto the requirement now, so changing the rule later never re-routes it. */
  const rule = m.purchaseMethod as PurchaseMethod;
  const method = rule === "buyer" ? null : rule;
  const preset = rule === "direct" && m.preferredSupplierId ? m.preferredSupplierId : null;
  const unit = purchaseUnit(m.unit, m.materialType);
  const newId = erpId("req");
  await db.insert(erpRequisitions).values({
    id: newId,
    reqDate: date,
    requiredBy,
    department,
    godownId,
    materialType: type,
    rawMaterialId: m.id,
    unit,
    requiredQty: qty,
    priority,
    remarks: text(h.remarks),
    purchaseRule: rule,
    method,
    ...(preset ? { supplierId: preset, vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id } : {}),
    createdById: ctx.user.id,
    updatedById: ctx.user.id,
  });
  await erpAudit(ctx, "erp.requisition.create", "erp_requisition", newId, null, { item, qty, priority, rule });
  const next =
    rule === "buyer"
      ? "the buyer decides how it is bought"
      : rule === "quotation"
        ? "collect quotations next"
        : preset
          ? "direct purchase from the item's default vendor — raise the PO next"
          : "direct purchase — select the vendor next";
  return okVoid(`Requirement raised · ${item} · ${nf(qty)} ${unit} · ${next}`);
}

/* ============================================================ quotations */

/** Requirements that are collecting quotations: method quotation, not cancelled, not yet on a PO. */
async function quotableRequirements(extraId?: string) {
  return (await requirementViews()).filter((v) => (v.method === "quotation" && !v.po && !v.legacy && v.r.status !== "Cancelled") || v.r.id === extraId);
}

function reqLabel(v: ReqView): string {
  return `${v.item} · ${nf(v.r.requiredQty)} ${v.r.unit} · ${v.godown} (${fd(v.r.reqDate)})`;
}

/** Stable, unique labels for requirements — the forms pick by label and the server reads the same map back. */
function labelled(views: ReqView[]): Map<string, ReqView> {
  const out = new Map<string, ReqView>();
  for (const v of views) {
    let l = reqLabel(v);
    for (let i = 2; out.has(l); i++) l = `${reqLabel(v)} #${i}`;
    out.set(l, v);
  }
  return out;
}

async function quotationForm(ctx: ErpContext, opts: { requisitionId?: string; quoteId?: string } = {}): Promise<FormSpec | null> {
  let editing: (typeof erpQuotations.$inferSelect & { supplier: string }) | undefined;
  if (opts.quoteId) {
    const [x] = await db
      .select({ q: erpQuotations, supplier: erpSuppliers.name })
      .from(erpQuotations)
      .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpQuotations.supplierId))
      .where(eq(erpQuotations.id, opts.quoteId));
    if (!x) return null;
    editing = { ...x.q, supplier: x.supplier };
  }
  const reqId = editing?.requisitionId ?? opts.requisitionId;
  const [views, sups, terms] = await Promise.all([
    quotableRequirements(reqId),
    db.select({ name: erpSuppliers.name }).from(erpSuppliers).where(eq(erpSuppliers.active, true)).orderBy(asc(erpSuppliers.name)),
    refValues("paymentTerms"),
  ]);
  const map = labelled(views);
  const qtyOf: Record<string, number> = {};
  const unitOf: Record<string, string> = {};
  map.forEach((v, l) => {
    qtyOf[l] = v.r.requiredQty;
    unitOf[l] = v.r.unit;
  });
  const preset = [...map].find(([, v]) => v.r.id === reqId)?.[0] ?? "";
  if (reqId && !preset) return null;
  return {
    screen: "quotations",
    id: editing ? "edit" : "new",
    recordId: editing?.id,
    title: editing ? `Edit quotation · ${editing.supplier}` : "Add a quotation",
    sub: "One vendor's price for one requirement. Quotations are compared on landed cost: rate × quantity, its GST, and the freight.",
    submit: editing ? "Save quotation" : "Add quotation",
    init: editing
      ? {
          requirement: preset,
          vendor: editing.supplier,
          date: editing.quoteDate,
          reference: editing.reference ?? "",
          rate: rupeesField(editing.ratePaise),
          gst: String(editing.gstBp / 100),
          freight: rupeesField(editing.freightPaise),
          deliveryDays: editing.deliveryDays == null ? "" : String(editing.deliveryDays),
          terms: editing.paymentTerms ?? "",
          validUntil: editing.validUntil ?? "",
          document: editing.documentId ?? "",
          remarks: editing.remarks ?? "",
        }
      : { requirement: preset, date: today(), gst: "18" },
    data: { qtyOf, unitOf },
    header: [
      {
        k: "requirement",
        l: "Requirement",
        t: "select",
        req: true,
        opts: [...map.keys()],
        readOnly: !!preset,
        hint: map.size ? undefined : "No requirement is collecting quotations. A requirement collects them when its item's rule is Quotation, or the buyer chose it.",
      },
      { k: "vendor", l: "Vendor", t: "select", req: true, opts: sups.map((s) => s.name), readOnly: !!editing },
      { k: "date", l: "Quotation date", t: "date", req: true },
      { k: "reference", l: "Vendor's quotation no", t: "text" },
      { k: "rate", l: "Rate per unit (₹, before GST)", t: "num", req: true, min: 0.01, sec: "Price" },
      { k: "gst", l: "GST %", t: "num", req: true, min: 0, max: 100 },
      { k: "freight", l: "Freight (₹, whole quantity)", t: "num", min: 0, hint: "Blank when delivery is free." },
      { k: "landed", l: "Landed cost", t: "derived", calc: "quotations.landed" },
      { k: "deliveryDays", l: "Delivery (days from PO)", t: "num", min: 0, sec: "Terms" },
      { k: "terms", l: "Payment terms", t: "select", opts: terms },
      { k: "validUntil", l: "Valid until", t: "date" },
      { k: "document", l: "Quotation (photo or PDF)", t: "photo" },
      { k: "remarks", l: "Remarks", t: "area", mic: true },
    ],
  };
}

async function saveQuotation(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  if (!ctx.powers.has("viewPurchaseMoney")) return err(`${MONEY_WHY}.`, "not_permitted");
  let existing: typeof erpQuotations.$inferSelect | undefined;
  if (id) {
    [existing] = await db.select().from(erpQuotations).where(eq(erpQuotations.id, id));
    if (!existing) return err("That quotation no longer exists.", "not_found");
  }
  const map = labelled(await quotableRequirements(existing?.requisitionId));
  const v = existing ? [...map.values()].find((x) => x.r.id === existing!.requisitionId) : map.get(text(h.requirement) ?? "");
  if (!v) return fieldErr("requirement", "Pick a requirement that is collecting quotations");
  if (v.po) return err(`The requirement is on ${poLabel(v.po.number)} — its quotations are closed.`, "conflict");
  if (v.method !== "quotation") return err("This requirement is not bought by quotation.", "rule_violation");
  const [sup] = existing
    ? await db.select().from(erpSuppliers).where(eq(erpSuppliers.id, existing.supplierId))
    : await db.select().from(erpSuppliers).where(and(eq(erpSuppliers.name, text(h.vendor) ?? ""), eq(erpSuppliers.active, true)));
  if (!sup) return fieldErr("vendor", "Pick an active vendor");
  const rate = paise(h.rate);
  if (rate == null || rate <= 0) return fieldErr("rate", "Rate is required");
  const gst = num(h.gst);
  if (gst == null || gst < 0 || gst > 100) return fieldErr("gst", "GST % is required");
  const freight = paise(h.freight) ?? 0;
  if (freight < 0) return fieldErr("freight", "Minus Quantity Not Allowed");
  const days = num(h.deliveryDays);
  if (days != null && days < 0) return fieldErr("deliveryDays", "Minus Quantity Not Allowed");
  const values = {
    quoteDate: text(h.date) ?? today(),
    reference: text(h.reference),
    ratePaise: rate,
    gstBp: Math.round(gst * 100),
    freightPaise: freight,
    deliveryDays: days == null ? null : Math.round(days),
    paymentTerms: text(h.terms),
    validUntil: text(h.validUntil),
    documentId: text(h.document),
    remarks: text(h.remarks),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  if (values.validUntil && values.validUntil < values.quoteDate) return fieldErr("validUntil", "Valid until cannot be before the quotation's date");
  const qid = existing?.id ?? erpId("quo");
  const res = await inTx(async (tx) => {
    if (existing) {
      await tx.update(erpQuotations).set(values).where(eq(erpQuotations.id, qid));
      /* A selected quotation's price is the requirement's price: changing it re-opens nothing, but the PO will read the new rate. */
    } else {
      const [dup] = await tx.select({ id: erpQuotations.id }).from(erpQuotations).where(and(eq(erpQuotations.requisitionId, v.r.id), eq(erpQuotations.supplierId, sup.id)));
      if (dup) refuse(fieldErr("vendor", `${sup.name} has already quoted for this — edit their quotation instead`));
      await tx.insert(erpQuotations).values({ id: qid, requisitionId: v.r.id, supplierId: sup.id, createdById: ctx.user.id, ...values });
    }
    await bindErpFiles(tx as unknown as typeof db, [values.documentId], "erp_quotation", qid, ctx.user.id);
    return okVoid(existing ? `Quotation from ${sup.name} saved` : `Quotation from ${sup.name} added · ${v.quotes.length + 1} for ${v.item}`);
  });
  if (res.ok) await erpAudit(ctx, existing ? "erp.quotation.edit" : "erp.quotation.create", "erp_quotation", qid, existing ?? null, { ...values, supplier: sup.name });
  return res;
}

/**
 * Selecting a quotation chooses the requirement's vendor and fixes the rate the
 * PO is raised at. Enough quotations must be in; an expired one cannot win; and
 * choosing other than the lowest landed cost needs the reason in words, because
 * that is exactly the decision an auditor asks about.
 */
async function selectQuotation(ctx: ErpContext, quoteId: string, note: string | null): Promise<Result<unknown>> {
  if (!ctx.powers.has("viewPurchaseMoney")) return err(`${MONEY_WHY}.`, "not_permitted");
  const [q] = await db.select().from(erpQuotations).where(eq(erpQuotations.id, quoteId));
  if (!q) return err("That quotation no longer exists.", "not_found");
  const [v] = await requirementViews({ ids: [q.requisitionId] });
  if (!v) return err("That requirement no longer exists.", "not_found");
  if (v.r.status === "Cancelled") return err("The requirement is cancelled.", "conflict");
  if (v.po) return err(`The requirement is on ${poLabel(v.po.number)} — cancel or send back the PO to change its quotation.`, "conflict");
  if (v.method !== "quotation") return err("This requirement is not bought by quotation.", "rule_violation");
  const min = (await getConfig())["erp.purchase.minQuotations"];
  if (v.quotes.length < min) return err(`At least ${min} quotation${min > 1 ? "s are" : " is"} needed before one is selected — ${v.quotes.length} in.`, "rule_violation");
  const day = today();
  if (quoteExpired(q.validUntil, day)) return err("That quotation has expired — ask the vendor to renew it.", "rule_violation");
  const ranked = rankQuotes(v.quotes, v.r.requiredQty, day);
  const me = ranked.find((x) => x.id === q.id)!;
  if (!me.lowest && !note) return fieldErr("note", `Not the lowest landed cost (${ranked[0].supplier} is ${inr(ranked[0].fig.landedPaise)}) — say why this one`);
  await db.transaction(async (tx) => {
    await tx.update(erpQuotations).set({ status: "Not selected", updatedAt: new Date() }).where(eq(erpQuotations.requisitionId, v.r.id));
    await tx.update(erpQuotations).set({ status: "Selected", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpQuotations.id, q.id));
    await tx
      .update(erpRequisitions)
      .set({ supplierId: q.supplierId, quotationId: q.id, selectionNote: note, vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(erpRequisitions.id, v.r.id));
  });
  await erpAudit(ctx, "erp.quotation.select", "erp_quotation", q.id, { quotationId: v.r.quotationId }, { requisitionId: v.r.id, lowest: me.lowest, note });
  return okVoid(`${me.supplier} selected at ${inr(me.fig.landedPaise)} landed · raise the PO next`);
}

const quotations: ScreenModule = {
  key: "quotations",
  async load(ctx) {
    const [views, form, config] = await Promise.all([requirementViews(), quotationForm(ctx), getConfig()]);
    const min = config["erp.purchase.minQuotations"];
    const money = ctx.powers.has("viewPurchaseMoney");
    const day = today();
    const all: Col[] = [
      { k: "requirement", l: "Requirement", t: "t" },
      { k: "vendor", l: "Vendor", t: "b" },
      { k: "date", l: "Date", t: "d" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "rate", l: "Rate", t: "m", pw: "viewPurchaseMoney" },
      { k: "gst", l: "GST %", t: "n" },
      { k: "freight", l: "Freight", t: "m", pw: "viewPurchaseMoney" },
      { k: "landed", l: "Landed cost", t: "m", pw: "viewPurchaseMoney" },
      { k: "perUnit", l: "Landed / unit", t: "m", pw: "viewPurchaseMoney" },
      { k: "rank", l: "Rank", t: "n" },
      { k: "delivery", l: "Delivery days", t: "n" },
      { k: "terms", l: "Payment terms", t: "t" },
      { k: "validUntil", l: "Valid until", t: "d" },
      { k: "status", l: "Status", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    const rows: ListRow[] = [];
    const labels = labelled(views);
    const labelOf = new Map([...labels].map(([l, v]) => [v.r.id, l]));
    for (const v of views) {
      const ranked = rankQuotes(v.quotes, v.r.requiredQty, day);
      const closed = !!v.po || v.r.status === "Cancelled" || v.legacy;
      for (const q of ranked) {
        const actions: ActionSpec[] = [];
        const status = q.id === v.r.quotationId ? "Selected" : q.status === "Selected" ? "Not selected" : q.status;
        if (!closed && q.id !== v.r.quotationId)
          actions.push({
            id: "select",
            l: "Select this quotation",
            primary: true,
            why: !money ? MONEY_WHY : q.expired ? "Expired — ask the vendor to renew it" : v.quotes.length < min ? `Needs at least ${min} quotations — ${v.quotes.length} in` : "",
            prompt: {
              title: `Select ${q.supplier}`,
              sub: q.lowest ? "The lowest landed cost." : `Not the lowest landed cost — ${ranked[0].supplier} is ${inr(ranked[0].fig.landedPaise)}. Say why.`,
              submit: "Select",
              fields: [{ k: "note", l: q.lowest ? "Note" : "Why this one", t: "area", req: !q.lowest }],
            },
          });
        if (!closed) actions.push({ id: "edit", l: "Edit", loadsForm: true, why: money ? "" : MONEY_WHY });
        if (!closed && q.id !== v.r.quotationId) actions.push({ id: "remove", l: "Remove", confirm: `Remove ${q.supplier}'s quotation for ${v.item}?`, why: money ? "" : MONEY_WHY });
        if (v.po) actions.push({ id: "openPo", l: `Open ${poLabel(v.po.number)}`, href: erpLink("purchaseOrders", { open: v.po.id }) });
        actions.push({ id: "openReq", l: "Open requirement", href: erpLink("requisitions", { open: v.r.id }) });
        const flags = [...(q.lowest ? ["lowestQuote"] : []), ...(q.expired ? ["quoteExpired"] : [])];
        rows.push({
          id: q.id,
          v: withoutHidden(
            {
              requirement: labelOf.get(v.r.id) ?? reqLabel(v),
              vendor: q.supplier,
              date: q.quoteDate,
              qty: v.r.requiredQty,
              rate: q.ratePaise,
              gst: q.gstBp / 100,
              freight: q.freightPaise,
              landed: q.fig.landedPaise,
              perUnit: q.fig.perUnitLandedPaise,
              rank: q.rank,
              delivery: q.deliveryDays,
              terms: q.paymentTerms,
              validUntil: q.validUntil,
              status,
            },
            hiddenKeys,
          ),
          flags,
          title: `${q.supplier} · ${v.item}`,
          header: `${nf(v.r.requiredQty)} ${v.r.unit} · rank ${q.rank} of ${ranked.length}${q.reference ? ` · their ref ${q.reference}` : ""}`,
          fields: [
            ...(money ? [{ l: "Material", v: inr(q.fig.materialPaise), der: true }, { l: "GST amount", v: inr(q.fig.gstPaise), der: true }] : []),
            { l: "Remarks", v: q.remarks || "—" },
          ],
          hiddenFields: money ? 0 : 2,
          contacts: q.documentId ? [{ l: "Open the quotation", href: `/api/attachments/${q.documentId}` }] : undefined,
          actions,
          by: stampLine(null, q.createdAt),
        });
      }
    }
    return {
      spec: {
        screen: "quotations",
        cols,
        hidden,
        groups: ["requirement"],
        chips: "status",
        sortDefault: ["rank", 1],
        newForm: money ? (form ?? undefined) : undefined,
        newLabel: "Add quotation",
        noDataLine: "No quotations yet. A requirement collects them when its item's purchase rule is Quotation.",
      },
      rows,
    };
  },
  formLoaders: {
    edit: (ctx, id) => quotationForm(ctx, { quoteId: id }),
  },
  forms: {
    async new(ctx, h) {
      return saveQuotation(ctx, h);
    },
    async edit(ctx, h, _l, id) {
      return saveQuotation(ctx, h, id);
    },
  },
  actions: {
    async select(ctx, id, values) {
      return selectQuotation(ctx, id, text(values.note));
    },
    async remove(ctx, id) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(`${MONEY_WHY}.`, "not_permitted");
      const [q] = await db.select().from(erpQuotations).where(eq(erpQuotations.id, id));
      if (!q) return err("That quotation no longer exists.", "not_found");
      const [v] = await requirementViews({ ids: [q.requisitionId] });
      if (v?.r.quotationId === id) return err("The selected quotation is not removed — select another first.", "conflict");
      if (v?.po) return err(`The requirement is on ${poLabel(v.po.number)}.`, "conflict");
      await db.delete(erpQuotations).where(eq(erpQuotations.id, id));
      await erpAudit(ctx, "erp.quotation.remove", "erp_quotation", id, q, null);
      return okVoid("Quotation removed");
    },
  },
};

/* ======================================================== purchase orders */

/** Everything the PO form needs: requirements ready for a PO (or already on the one being edited), by vendor. */
async function poFormData(editingPoId?: string, kit?: DutyKit) {
  const [views, config] = await Promise.all([requirementViews(), getConfig()]);
  const min = config["erp.purchase.minQuotations"];
  /* With a kit: only what this person may put on a PO (`material-duties.ts`). */
  const eligible = views.filter(
    (v) =>
      (stageOf(v, min).readyForPo || (editingPoId && v.po?.id === editingPoId)) &&
      (!kit || !v.r.rawMaterialId || kit.allows(v.r.rawMaterialId, "raisePo")),
  );
  return { eligible, map: labelled(eligible) };
}

export async function purchaseOrderForm(ctx: ErpContext, opts: { supplierId?: string; focus?: string; poId?: string } = {}): Promise<FormSpec | null> {
  const kit = await dutyKit(ctx);
  const [{ map }, gds, sups, terms] = await Promise.all([
    poFormData(opts.poId, kit),
    godownOptions(ctx, { lost: false }),
    db.select().from(erpSuppliers).orderBy(asc(erpSuppliers.name)),
    refValues("paymentTerms"),
  ]);
  const supById = new Map(sups.map((s) => [s.id, s]));
  const byVendor: Record<string, string[]> = {};
  const qtyOf: Record<string, string> = {};
  const rateOf: Record<string, string> = {};
  const gstOf: Record<string, string> = {};
  const itemOf: Record<string, string> = {};
  const unitOf: Record<string, string> = {};
  const quotedOf: Record<string, string> = {};
  map.forEach((v, l) => {
    const vendor = supById.get(v.r.supplierId ?? "")?.name;
    if (!vendor) return;
    (byVendor[vendor] ??= []).push(l);
    qtyOf[l] = String(v.r.requiredQty);
    itemOf[l] = v.item;
    unitOf[l] = v.r.unit;
    if (v.selected) {
      rateOf[l] = rupeesField(v.selected.ratePaise);
      gstOf[l] = String(v.selected.gstBp / 100);
      quotedOf[l] = rupeesField(v.selected.ratePaise);
    } else gstOf[l] = "18";
  });
  let po: PoView | undefined;
  if (opts.poId) {
    [po] = await purchaseOrderViews({ ids: [opts.poId] });
    if (!po) return null;
  }
  const vendorId = po?.po.supplierId ?? opts.supplierId;
  const vendor = vendorId ? supById.get(vendorId) : undefined;
  const focus = opts.focus ? [...map].find(([, v]) => v.r.id === opts.focus) : undefined;
  const labelOfReq = new Map([...map].map(([l, v]) => [v.r.id, l]));
  const initLines = po
    ? po.lines.map((l) => ({
        requirement: labelOfReq.get(l.requisitionId) ?? "",
        qty: String(l.quantity),
        rate: rupeesField(l.ratePaise),
        gst: String(l.gstBp / 100),
      }))
    : vendor
      ? (byVendor[vendor.name] ?? []).map((l) => ({ requirement: l, qty: qtyOf[l], rate: rateOf[l] ?? "", gst: gstOf[l] ?? "18" }))
      : undefined;
  const firstReq = focus?.[1] ?? (vendor ? map.get((byVendor[vendor.name] ?? [])[0] ?? "") : undefined);
  const quoteTerms = firstReq?.selected?.paymentTerms ?? null;
  const vendorTerms = vendor?.creditDays ? `${vendor.creditDays} days credit` : null;
  const term = po?.po.paymentTerms ?? quoteTerms ?? vendorTerms ?? "";
  const days = firstReq?.selected?.deliveryDays;
  /* Calendar arithmetic on a date string — noon UTC, so no zone can move the day. */
  const addDays = (iso: string, n: number) => calendarDate(new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000));
  const deliveryInit = po?.po.deliveryDate ?? (days != null ? addDays(today(), days) : (firstReq?.r.requiredBy ?? ""));
  const vendors = Object.keys(byVendor).sort();
  if (vendor && !vendors.includes(vendor.name)) vendors.push(vendor.name);
  return {
    screen: "purchaseOrders",
    id: po ? "edit" : "new",
    recordId: po?.po.id,
    title: po ? `Edit ${poLabel(po.po.poNumber)}` : "New purchase order",
    sub: po
      ? "Only a PO still awaiting approval is edited. Saving keeps it waiting for approval."
      : "Raised from requirements whose vendor is chosen. It goes for approval on save, and only an approved PO can be sent or received against.",
    submit: po ? "Save PO" : "Raise PO for approval",
    lineLabel: "Item",
    init: {
      date: po?.po.poDate ?? today(),
      vendor: vendor?.name ?? "",
      deliverTo: po?.godown ?? firstReq?.godown ?? ctx.workingGodown?.name ?? "",
      deliveryDate: deliveryInit,
      terms: term,
      freight: po ? rupeesField(po.po.freightPaise) : firstReq?.selected?.freightPaise ? rupeesField(firstReq.selected.freightPaise) : "",
      remarks: po?.po.remarks ?? "",
      poNo: po ? poLabel(po.po.poNumber) : "",
    },
    initLines,
    data: { itemOf, unitOf, quotedOf },
    header: [
      { k: "po", l: "PO number", t: "derived", calc: "purchaseOrders.number" },
      { k: "date", l: "PO date", t: "date", req: true },
      {
        k: "vendor",
        l: "Vendor",
        t: "select",
        req: true,
        opts: vendors,
        readOnly: !!vendor,
        hint: vendors.length ? undefined : "No requirement is ready for a PO. A requirement is ready once its vendor is chosen — directly, or by selecting a quotation.",
      },
      { k: "deliverTo", l: "Deliver to", t: "select", req: true, opts: gds.map((g) => g.name) },
      { k: "deliveryDate", l: "Delivery date", t: "date", req: true },
      { k: "terms", l: "Payment terms", t: "select", req: true, opts: term && !terms.includes(term) ? [...terms, term] : terms },
      { k: "freight", l: "Freight (₹)", t: "num", min: 0, hint: "Freight on the whole PO, beyond the items. Blank when delivery is free." },
      { k: "remarks", l: "Remarks for the vendor", t: "area", mic: true },
    ],
    line: [
      { k: "requirement", l: "Requirement", t: "select", req: true, optsBy: { by: "vendor", map: byVendor } },
      { k: "item", l: "Item", t: "derived", calc: "purchaseOrders.item" },
      { k: "qty", l: "Quantity", t: "num", req: true, min: 0.001, fillBy: { by: ["requirement"], map: qtyOf } },
      { k: "unit", l: "Unit", t: "derived", calc: "purchaseOrders.unit" },
      { k: "rate", l: "Rate per unit (₹)", t: "num", req: true, min: 0.01, fillBy: { by: ["requirement"], map: rateOf } },
      { k: "gst", l: "GST %", t: "num", req: true, min: 0, max: 100, def: "18", fillBy: { by: ["requirement"], map: gstOf } },
      { k: "amount", l: "Line total", t: "derived", calc: "purchaseOrders.amount" },
    ],
  };
}

async function savePurchaseOrder(ctx: ErpContext, h: Record<string, string>, lines: Record<string, string>[], poId?: string): Promise<Result<unknown>> {
  if (!ctx.powers.has("viewPurchaseMoney")) return err(`${MONEY_WHY}.`, "not_permitted");
  const [vendor] = await db.select().from(erpSuppliers).where(eq(erpSuppliers.name, text(h.vendor) ?? ""));
  if (!vendor) return fieldErr("vendor", "Vendor is required");
  const godownId = await godownIdByName(text(h.deliverTo));
  if (!godownId) return fieldErr("deliverTo", "Deliver to is required");
  const date = text(h.date) ?? today();
  const deliveryDate = text(h.deliveryDate);
  if (!deliveryDate) return fieldErr("deliveryDate", "Delivery date is required");
  if (deliveryDate < date) return fieldErr("deliveryDate", "Delivery cannot be before the PO date");
  const terms = text(h.terms);
  if (!terms) return fieldErr("terms", "Payment terms are required");
  const freight = paise(h.freight) ?? 0;
  if (freight < 0) return fieldErr("freight", "Minus Quantity Not Allowed");
  if (!lines.length) return err("Add at least one item.");
  const [{ map }, duties] = await Promise.all([poFormData(poId), dutyKit(ctx)]);
  const parsed: { v: ReqView; qty: number; rate: number; gstBp: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const v = map.get(text(l.requirement) ?? "");
    if (!v) return fieldErr(`l${i}.requirement`, "Pick a requirement ready for a PO");
    if (seen.has(v.r.id)) return fieldErr(`l${i}.requirement`, "This requirement is already on the PO");
    if (v.r.rawMaterialId && !duties.allows(v.r.rawMaterialId, "raisePo"))
      return fieldErr(`l${i}.requirement`, `${duties.refusal({ id: v.r.rawMaterialId, name: v.item }, "raisePo")}.`);
    seen.add(v.r.id);
    if (v.r.supplierId !== vendor.id) return fieldErr(`l${i}.requirement`, `This requirement's vendor is not ${vendor.name}`);
    const qty = num(l.qty);
    if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, qty != null && qty < 0 ? "Minus Quantity Not Allowed" : "Quantity is required");
    const rate = paise(l.rate);
    if (rate == null || rate <= 0) return fieldErr(`l${i}.rate`, "Rate is required");
    if (v.method === "quotation") {
      if (!v.selected) return fieldErr(`l${i}.requirement`, "Select a quotation for this requirement first");
      if (rate !== v.selected.ratePaise) return fieldErr(`l${i}.rate`, `The selected quotation is ${inrRate(v.selected.ratePaise)} — change the quotation, not the PO`);
    }
    const gst = num(l.gst);
    if (gst == null || gst < 0 || gst > 100) return fieldErr(`l${i}.gst`, "GST % is required");
    parsed.push({ v, qty, rate, gstBp: Math.round(gst * 100) });
  }
  let number = 0;
  const id = poId ?? erpId("po");
  const res = await inTx(async (tx) => {
    /* Lock the requirements, then ask again inside the transaction: two POs raised at once must not both take one. */
    await tx.execute(sql`select id from erp_requisitions where id in (${sql.join(parsed.map((p) => sql`${p.v.r.id}`), sql`, `)}) for update`);
    const taken = (await tx.execute(sql`
      select l.requisition_id as req, o.po_number as n from erp_po_lines l join erp_purchase_orders o on o.id = l.po_id
       where l.requisition_id in (${sql.join(parsed.map((p) => sql`${p.v.r.id}`), sql`, `)})
         and o.status in (${sql.join(LIVE_PO.map((s) => sql`${s}`), sql`, `)}) and o.id <> ${id}
    `)) as unknown as { req: string; n: number }[];
    if (taken.length) {
      const i = parsed.findIndex((p) => p.v.r.id === taken[0].req);
      refuse(fieldErr(`l${i}.requirement`, `Already on ${poLabel(taken[0].n)}`));
    }
    const cancelled = (await tx.select({ id: erpRequisitions.id }).from(erpRequisitions).where(and(inArray(erpRequisitions.id, parsed.map((p) => p.v.r.id)), eq(erpRequisitions.status, "Cancelled"))));
    if (cancelled.length) refuse(err("A requirement on this PO was cancelled meanwhile.", "conflict"));
    const header = { poDate: date, supplierId: vendor.id, godownId, deliveryDate, paymentTerms: terms, freightPaise: freight, remarks: text(h.remarks), updatedAt: new Date(), updatedById: ctx.user.id };
    if (poId) {
      const [before] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, poId)).for("update");
      if (!before) refuse(err("That PO no longer exists.", "not_found"));
      if (before.status !== "Pending approval") refuse(err(`${poLabel(before.poNumber)} is ${before.status} — only a PO awaiting approval is edited.`, "conflict"));
      number = before.poNumber;
      await tx.update(erpPurchaseOrders).set(header).where(eq(erpPurchaseOrders.id, poId));
      await tx.delete(erpPoLines).where(eq(erpPoLines.poId, poId));
    } else {
      number = await nextNumber(tx, "po");
      await tx.insert(erpPurchaseOrders).values({ id, poNumber: number, status: "Pending approval", createdById: ctx.user.id, ...header });
    }
    let i = 0;
    for (const p of parsed)
      await tx.insert(erpPoLines).values({
        id: erpId("pol"),
        poId: id,
        requisitionId: p.v.r.id,
        rawMaterialId: p.v.r.rawMaterialId!,
        quantity: p.qty,
        unit: p.v.r.unit,
        ratePaise: p.rate,
        gstBp: p.gstBp,
        sortOrder: i++,
      });
    const t = poTotals(parsed.map((p) => ({ quantity: p.qty, ratePaise: p.rate, gstBp: p.gstBp })), freight);
    return ok({ id }, `${poLabel(number)} ${poId ? "saved" : "raised"} · ${inr(t.totalPaise)} · waiting for approval`);
  });
  if (res.ok) await erpAudit(ctx, poId ? "erp.purchaseOrder.edit" : "erp.purchaseOrder.create", "erp_purchase_order", id, null, { number, vendor: vendor.name, lines: parsed.length });
  return res;
}

function poPanel(p: PoView, money: boolean) {
  const t = poTotals(p.lines, p.po.freightPaise);
  const step = ["Pending approval"].includes(p.po.status) ? 3 : p.po.status === "Approved" ? 4 : ["Sent", "Partly received"].includes(p.po.status) ? 5 : ["Received", "Closed"].includes(p.po.status) ? 6 : -1;
  const history: { l: string; v: string }[] = [{ l: "Raised", v: stampLine(p.by, p.po.createdAt).replace(/^Created /, "") }];
  if (p.po.approvedAt) history.push({ l: p.po.status === "Rejected" ? "Sent back" : "Approved", v: stampLine(p.approver, p.po.approvedAt).replace(/^Created /, "") + (p.po.decisionNote ? ` — ${p.po.decisionNote}` : "") });
  if (p.po.sentAt) history.push({ l: "Sent to vendor", v: `${p.po.sentVia ?? ""} · ${stampLine(null, p.po.sentAt).replace(/^Created /, "")}` });
  if (p.po.closedAt) history.push({ l: p.po.status === "Cancelled" ? "Cancelled" : "Closed", v: `${stampLine(null, p.po.closedAt).replace(/^Created /, "")}${p.po.closeReason ? ` — ${p.po.closeReason}` : ""}` });
  return {
    kind: "purchaseOrder",
    data: {
      steps: FLOW_STEPS,
      step,
      status: p.po.status,
      money,
      lines: p.lines.map((l) => {
        const f = poLineFigures(l);
        return {
          item: l.item,
          ordered: `${nf(l.quantity)} ${l.unit}`,
          received: `${nf(l.received)} ${l.unit}`,
          pending: `${nf(Math.max(0, l.quantity - l.received))} ${l.unit}`,
          done: l.received >= l.quantity,
          rate: money ? inrRate(l.ratePaise) : null,
          gst: `${l.gstBp / 100}%`,
          total: money ? inr(f.totalPaise) : null,
          requirement: erpLink("requisitions", { open: l.requisitionId }),
        };
      }),
      totals: money ? { amount: inr(t.amountPaise), gst: inr(t.gstPaise), freight: inr(t.freightPaise), total: inr(t.totalPaise) } : null,
      history,
      print: p.po.approvedAt && p.po.status !== "Rejected" ? `/erp/po/${p.po.id}` : null,
    },
  };
}

/**
 * Whether this person may decide (approve or send back) the PO: for every
 * line, the material's named approvers where they are set, the "Approve
 * purchase orders" power where they are not. Null: they may.
 */
async function approvalRefusal(ctx: ErpContext, poId: string): Promise<Result<unknown> | null> {
  const [[p], kit] = await Promise.all([purchaseOrderViews({ ids: [poId] }), dutyKit(ctx)]);
  if (!p) return err("That PO no longer exists.", "not_found");
  const approver = ctx.powers.has("approvePurchaseOrder");
  const line = p.lines.find((l) => !kit.allows(l.rawMaterialId, "approve", approver));
  if (!line) return null;
  return err(`${kit.refusal({ id: line.rawMaterialId, name: line.item }, "approve") ?? "Only the PO approver decides a purchase order"}.`, "not_permitted");
}

const purchaseOrders: ScreenModule = {
  key: "purchaseOrders",
  async load(ctx) {
    const [pos, form, kit] = await Promise.all([purchaseOrderViews(), purchaseOrderForm(ctx), dutyKit(ctx)]);
    const money = ctx.powers.has("viewPurchaseMoney");
    const approver = ctx.powers.has("approvePurchaseOrder");
    const canReceive = ctx.screens.has("inward");
    const day = today();
    const all: Col[] = [
      { k: "po", l: "PO no", t: "mono" },
      { k: "date", l: "PO date", t: "d" },
      { k: "vendor", l: "Vendor", t: "b" },
      { k: "items", l: "Items", t: "t" },
      { k: "deliverTo", l: "Deliver to", t: "t" },
      { k: "deliveryDate", l: "Delivery date", t: "d" },
      { k: "value", l: "PO value", t: "m", pw: "viewPurchaseMoney" },
      { k: "terms", l: "Payment terms", t: "t" },
      { k: "received", l: "Received", t: "t" },
      { k: "status", l: "Status", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    const rows: ListRow[] = pos.map((p) => {
      const s = p.po.status;
      const t = poTotals(p.lines, p.po.freightPaise);
      const anyReceived = p.lines.some((l) => l.received > 0);
      const doneLines = p.lines.filter((l) => l.received >= l.quantity).length;
      const self = p.po.createdById === ctx.user.id && !ctx.administrator;
      const actions: ActionSpec[] = [];
      /* Approval follows each line's material where its approver is set, and the power where it is not. */
      const notMine = p.lines.find((l) => !kit.allows(l.rawMaterialId, "approve", approver));
      const approveWhy = notMine ? (kit.refusal({ id: notMine.rawMaterialId, name: notMine.item }, "approve") ?? "Only the PO approver approves") : "";
      const notRaisable = p.lines.find((l) => !kit.allows(l.rawMaterialId, "raisePo"));
      const editWhy = notRaisable ? (kit.refusal({ id: notRaisable.rawMaterialId, name: notRaisable.item }, "raisePo") ?? "") : "";
      if (s === "Pending approval") {
        actions.push({
          id: "approve",
          l: "Approve",
          primary: true,
          why: approveWhy || (self ? "You raised this PO — another approver approves it" : ""),
          prompt: { title: `Approve ${poLabel(p.po.poNumber)}`, sub: `${p.supplier} · ${money ? inr(t.totalPaise) : `${p.lines.length} items`}`, submit: "Approve PO", fields: [{ k: "note", l: "Note", t: "area" }] },
        });
        actions.push({
          id: "sendBack",
          l: "Send back",
          why: approveWhy,
          prompt: { title: `Send back ${poLabel(p.po.poNumber)}`, sub: "Its requirements return to Ready for PO, to be raised again corrected.", submit: "Send back", fields: [{ k: "reason", l: "What needs changing", t: "area", req: true }] },
        });
        actions.push({ id: "edit", l: "Edit", loadsForm: true, why: money ? editWhy : MONEY_WHY });
      }
      if (s === "Approved" || s === "Sent" || s === "Partly received") {
        actions.push({
          id: "send",
          l: s === "Approved" ? "Send to vendor" : "Send again",
          primary: s === "Approved",
          prompt: {
            title: `Send ${poLabel(p.po.poNumber)} to ${p.supplier}`,
            sub: "Records how it went. WhatsApp and email open with the PO written out; a printed copy opens the PO to print.",
            submit: "Send",
            fields: [{ k: "via", l: "Send by", t: "select", req: true, opts: ["WhatsApp", "Email", "Printed copy", "Phone"] }],
            init: { via: p.supplierPhone ? "WhatsApp" : p.supplierEmail ? "Email" : "Printed copy" },
          },
        });
        actions.push({ id: "receive", l: "Receive goods", primary: s !== "Approved", loadsForm: true, why: canReceive ? "" : "Goods receipt is not on your account" });
      }
      if (s === "Partly received")
        actions.push({
          id: "close",
          l: "Close short",
          prompt: { title: `Close ${poLabel(p.po.poNumber)} short`, sub: "Nothing more is expected against it; its requirements count as received.", submit: "Close PO", fields: [{ k: "reason", l: "Why", t: "area", req: true }] },
        });
      if (["Pending approval", "Approved", "Sent"].includes(s))
        actions.push({
          id: "cancel",
          l: "Cancel PO",
          why: anyReceived ? "Goods were received against it — close it short instead" : "",
          prompt: { title: `Cancel ${poLabel(p.po.poNumber)}`, sub: "Its requirements return to Ready for PO, keeping their vendor.", submit: "Cancel PO", fields: [{ k: "reason", l: "Reason", t: "area", req: true }] },
        });
      if (p.po.approvedAt && s !== "Rejected") actions.push({ id: "print", l: "Print PO", href: `/erp/po/${p.po.id}` });
      const flags: string[] = [];
      if (s === "Pending approval") flags.push("awaitingApproval");
      if (RECEIVABLE_PO.includes(s) && p.po.deliveryDate < day) flags.push("deliveryLate");
      return {
        id: p.po.id,
        v: withoutHidden(
          {
            po: poLabel(p.po.poNumber),
            date: p.po.poDate,
            vendor: p.supplier,
            items: p.lines.map((l) => l.item).join(", "),
            deliverTo: p.godown,
            deliveryDate: p.po.deliveryDate,
            value: t.totalPaise,
            terms: p.po.paymentTerms,
            received:
              p.lines.length === 1
                ? `${nf(p.lines[0].received)} of ${nf(p.lines[0].quantity)} ${p.lines[0].unit}`
                : p.lines.length
                  ? `${doneLines} of ${p.lines.length} items in full`
                  : "—",
            status: s,
          },
          hiddenKeys,
        ),
        flags,
        title: `${poLabel(p.po.poNumber)} · ${p.supplier}`,
        header: `${fd(p.po.poDate)} · deliver to ${p.godown} by ${fd(p.po.deliveryDate)} · ${p.po.paymentTerms}`,
        fields: [{ l: "Remarks", v: p.po.remarks || "—" }],
        contacts: [
          ...(p.supplierPhone ? [{ l: `Call ${p.supplierPhone}`, href: `tel:${p.supplierPhone.replace(/\D/g, "")}` }] : []),
          ...(p.supplierEmail ? [{ l: "Email", href: `mailto:${p.supplierEmail}` }] : []),
        ],
        actions,
        panel: poPanel(p, money),
        by: stampLine(p.by, p.po.createdAt),
      };
    });
    return {
      spec: {
        screen: "purchaseOrders",
        cols,
        hidden,
        groups: ["status"],
        chips: "status",
        newForm: money ? (form ?? undefined) : undefined,
        newLabel: "New PO",
        noDataLine: "No purchase orders yet. Raise one from a requirement whose vendor is chosen.",
      },
      rows,
    };
  },
  formLoaders: {
    edit: (ctx, id) => purchaseOrderForm(ctx, { poId: id }),
    receive: async (ctx, id) => (await import("./purchase")).inwardFormForPo(ctx, id),
  },
  forms: {
    async new(ctx, h, lines) {
      return savePurchaseOrder(ctx, h, lines);
    },
    async edit(ctx, h, lines, id) {
      if (!id) return err("No PO named.", "not_found");
      return savePurchaseOrder(ctx, h, lines, id);
    },
  },
  actions: {
    async approve(ctx, id, values) {
      const refused = await approvalRefusal(ctx, id);
      if (refused) return refused;
      const res = await inTx(async (tx) => {
        const [po] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, id)).for("update");
        if (!po) return err("That PO no longer exists.", "not_found");
        if (po.status !== "Pending approval") return err(`${poLabel(po.poNumber)} is ${po.status}.`, "conflict");
        if (po.createdById === ctx.user.id && !ctx.administrator) return err("You raised this PO — another approver approves it.", "not_permitted");
        await tx
          .update(erpPurchaseOrders)
          .set({ status: "Approved", approvedById: ctx.user.id, approvedAt: new Date(), decisionNote: text(values.note), updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(erpPurchaseOrders.id, id));
        const reqs = (await tx.select({ id: erpPoLines.requisitionId }).from(erpPoLines).where(eq(erpPoLines.poId, id))).map((r) => r.id);
        if (reqs.length) await tx.update(erpRequisitions).set({ status: "Order Placed", updatedAt: new Date() }).where(inArray(erpRequisitions.id, reqs));
        return okVoid(`${poLabel(po.poNumber)} approved · send it to the vendor`);
      });
      if (res.ok) await erpAudit(ctx, "erp.purchaseOrder.approve", "erp_purchase_order", id, null, { note: text(values.note) });
      return res;
    },
    async sendBack(ctx, id, values) {
      const refused = await approvalRefusal(ctx, id);
      if (refused) return refused;
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say what needs changing");
      const [po] = await db.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, id));
      if (!po) return err("That PO no longer exists.", "not_found");
      if (po.status !== "Pending approval") return err(`${poLabel(po.poNumber)} is ${po.status}.`, "conflict");
      await db
        .update(erpPurchaseOrders)
        .set({ status: "Rejected", approvedById: ctx.user.id, approvedAt: new Date(), decisionNote: reason, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(and(eq(erpPurchaseOrders.id, id), eq(erpPurchaseOrders.status, "Pending approval")));
      await erpAudit(ctx, "erp.purchaseOrder.sendBack", "erp_purchase_order", id, null, { reason });
      return okVoid(`${poLabel(po.poNumber)} sent back · its requirements are ready for a new PO`);
    },
    async send(ctx, id, values) {
      const via = text(values.via);
      if (!via || !["WhatsApp", "Email", "Printed copy", "Phone"].includes(via)) return fieldErr("via", "How was it sent?");
      const [p] = await purchaseOrderViews({ ids: [id] });
      if (!p) return err("That PO no longer exists.", "not_found");
      if (!["Approved", "Sent", "Partly received"].includes(p.po.status))
        return err(p.po.status === "Pending approval" ? "A PO is approved before it goes to the vendor." : `${poLabel(p.po.poNumber)} is ${p.po.status}.`, "rule_violation");
      await db
        .update(erpPurchaseOrders)
        .set({ status: p.po.status === "Approved" ? "Sent" : p.po.status, sentAt: new Date(), sentById: ctx.user.id, sentVia: via, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpPurchaseOrders.id, id));
      await erpAudit(ctx, "erp.purchaseOrder.send", "erp_purchase_order", id, null, { via });
      const message = poMessage({
        number: p.po.poNumber,
        date: fd(p.po.poDate) + " " + p.po.poDate.slice(0, 4),
        vendor: p.supplier,
        deliverTo: p.godown,
        deliveryDate: fd(p.po.deliveryDate) + " " + p.po.deliveryDate.slice(0, 4),
        paymentTerms: p.po.paymentTerms,
        freightPaise: p.po.freightPaise,
        remarks: p.po.remarks,
        lines: p.lines.map((l) => ({ item: l.item, quantity: l.quantity, unit: l.unit, ratePaise: l.ratePaise, gstBp: l.gstBp })),
        company: "Mahek Marketing India",
      });
      const digits = (p.supplierPhone ?? "").replace(/\D/g, "");
      const open =
        via === "WhatsApp" && digits.length >= 10
          ? { label: "Open WhatsApp", href: `https://wa.me/91${digits.slice(-10)}?text=${encodeURIComponent(message)}` }
          : via === "Email" && p.supplierEmail
            ? { label: "Open email", href: `mailto:${p.supplierEmail}?subject=${encodeURIComponent(`Purchase order ${poLabel(p.po.poNumber)}`)}&body=${encodeURIComponent(message)}` }
            : { label: "Open the PO to print", href: `/erp/po/${p.po.id}` };
      const data: ToolResult = {
        dialog: {
          title: `${poLabel(p.po.poNumber)} · sent by ${via}`,
          sub:
            via === "WhatsApp" && digits.length < 10
              ? `${p.supplier} has no WhatsApp or mobile number on the supplier master — copy the PO and send it from your phone.`
              : via === "Email" && !p.supplierEmail
                ? `${p.supplier} has no email on the supplier master — copy the PO and send it yourself.`
                : "The PO, written out for the vendor.",
          text: message,
          copy: true,
          open,
        },
      };
      return ok(data, `${poLabel(p.po.poNumber)} marked sent by ${via}`);
    },
    async close(ctx, id, values) {
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say why it is closed short");
      const res = await inTx(async (tx) => {
        const [po] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, id)).for("update");
        if (!po) return err("That PO no longer exists.", "not_found");
        if (po.status !== "Partly received") return err("Only a partly received PO is closed short — cancel one that has received nothing.", "conflict");
        await tx
          .update(erpPurchaseOrders)
          .set({ status: "Closed", closeReason: reason, closedAt: new Date(), closedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(erpPurchaseOrders.id, id));
        const reqs = (await tx.select({ id: erpPoLines.requisitionId }).from(erpPoLines).where(eq(erpPoLines.poId, id))).map((r) => r.id);
        if (reqs.length) await tx.update(erpRequisitions).set({ status: "Received", updatedAt: new Date() }).where(inArray(erpRequisitions.id, reqs));
        return okVoid(`${poLabel(po.poNumber)} closed short`);
      });
      if (res.ok) await erpAudit(ctx, "erp.purchaseOrder.closeShort", "erp_purchase_order", id, null, { reason });
      return res;
    },
    async cancel(ctx, id, values) {
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say why it is cancelled");
      const res = await inTx(async (tx) => {
        const [po] = await tx.select().from(erpPurchaseOrders).where(eq(erpPurchaseOrders.id, id)).for("update");
        if (!po) return err("That PO no longer exists.", "not_found");
        if (!["Pending approval", "Approved", "Sent"].includes(po.status)) return err(`${poLabel(po.poNumber)} is ${po.status}.`, "conflict");
        const lines = await tx.select().from(erpPoLines).where(eq(erpPoLines.poId, id));
        const received = await receivedByLine(tx);
        if (lines.some((l) => (received.get(l.id) ?? 0) > 0)) return err("Goods were received against it — close it short instead.", "conflict");
        await tx
          .update(erpPurchaseOrders)
          .set({ status: "Cancelled", closeReason: reason, closedAt: new Date(), closedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(erpPurchaseOrders.id, id));
        const reqs = lines.map((l) => l.requisitionId);
        if (reqs.length)
          await tx
            .update(erpRequisitions)
            .set({ status: "Pending", updatedAt: new Date() })
            .where(and(inArray(erpRequisitions.id, reqs), sql`${erpRequisitions.status} <> 'Cancelled'`));
        return okVoid(`${poLabel(po.poNumber)} cancelled · its requirements are ready for a new PO`);
      });
      if (res.ok) await erpAudit(ctx, "erp.purchaseOrder.cancel", "erp_purchase_order", id, null, { reason });
      return res;
    },
  },
};

/** Badge counts for the sidebar: requirements waiting on somebody, and POs waiting on approval or on being sent. */
export async function purchaseFlowCounts(ctx: ErpContext): Promise<{ requisitions: number; purchaseOrders: number }> {
  const [work, pos, kit] = await Promise.all([requirementWork(ctx), purchaseOrderViews({ status: ["Pending approval", "Approved"] }), dutyKit(ctx)]);
  const buyer = ctx.powers.has("purchaseBuyer");
  const requisitions = REQUIREMENT_ACTION_STAGES.filter((s) => s !== "Buyer decision" || buyer).reduce((n, s) => n + (work[s]?.length ?? 0), 0);
  const approver = ctx.powers.has("approvePurchaseOrder");
  const purchaseOrders = pos.filter(
    (p) =>
      p.po.status === "Approved" ||
      (kit.allowsAll(p.lines.map((l) => l.rawMaterialId), "approve", approver) && (p.po.createdById !== ctx.user.id || ctx.administrator)),
  ).length;
  return { requisitions, purchaseOrders };
}

export const PURCHASE_FLOW_SCREENS: ScreenModule[] = [requisitions, quotations, purchaseOrders];
