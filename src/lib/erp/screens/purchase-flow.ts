import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  erpFgLevels,
  erpGodowns,
  erpPoLines,
  erpProductPacking,
  erpPurchaseOrders,
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
import { categoriesFor, categoriesForDepartment, requirementDepartmentsFor, requirementRefusal, requirementVisibleTo } from "../departments";
import { erpLink } from "../registry";
import { erpPoHref } from "../trace-links";
import { erpAudit, erpId, nextNumber, num, paise, rupeesField, stampLine, text, visibleCols, withoutHidden, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FormSpec, ListRow } from "../ui";
import { fd, inr, inrRate, nf } from "../ui";
import {
  FLOW_STEPS,
  LIVE_PO,
  RECEIVABLE_PO,
  methodByLabel,
  itemPickLabels,
  methodLabel,
  poLabel,
  poName,
  poRouteOf,
  poLineFigures,
  poStatusAfterReceipt,
  poTotals,
  purchaseUnit,
  requirementLabel,
  requirementStage,
  type PurchaseMethod,
  type Stage,
} from "../engines/purchase-flow";
import { fgLevelAvailable, rmLevelAvailable, rmLots } from "../stock";
import { godownIdByName, godownOptions, has, inTx, materials, refuse, today, type Col, type Tx } from "./common";
import { countLabel, gatesFor, notifyStockFlag, openCount, type GateInfo } from "../stock-check";
import { openRequirementCounts, writeCounted } from "./stock-check";

/* ---------------------------------------------------------------------------
 * THE PURCHASE FLOW'S FIRST FOUR STEPS (docs: AGENTS.md, "The purchase flow"):
 *
 *   Requirement → Purchase method → Vendor / quotation → Approval → PO → Receipt
 *
 * Requirements (`requisitions`) and Purchase orders. Supplier rates are kept on
 * the Quotation manager, not on a requirement.
 * The receipt is goods inward and the register (`purchase.ts`), which refuse
 * anything that does not name an approved PO's line.
 *
 * Every step is decided by the server from the requirement's own record — the
 * method from the item's purchase rule copied on raise, the vendor from a
 * direct choice or the Quotation manager's PO number, the PO from the requirement it names
 * — and a step that is not available yet says why, rather than being hidden.
 * ------------------------------------------------------------------------- */

const MONEY_WHY = "Purchase money is not on your account";

/* ======================================================== reading the flow */

type Req = typeof erpRequisitions.$inferSelect;

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
  po: { id: string; number: number; name: string; source: string; status: string; lineId: string; ordered: number; received: number; ratePaise: number; gstBp: number; drums: number | null; supplier: string } | null;
  legacy: boolean;
  by: string | null;
  /** Inventory Accuracy Control: the blind count this requirement waits to have entered, and what it found. */
  stock: GateInfo | null;
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
  const [lines, received, gates] = await Promise.all([
    ids.length
      ? db
          .select({
            l: erpPoLines,
            number: erpPurchaseOrders.poNumber,
            qm: erpPurchaseOrders.qmPoNo,
            source: erpPurchaseOrders.source,
            status: erpPurchaseOrders.status,
            createdAt: erpPurchaseOrders.createdAt,
            supplier: erpSuppliers.name,
          })
          .from(erpPoLines)
          .innerJoin(erpPurchaseOrders, eq(erpPurchaseOrders.id, erpPoLines.poId))
          .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpPurchaseOrders.supplierId))
          .where(and(inArray(erpPoLines.requisitionId, ids), inArray(erpPurchaseOrders.status, LIVE_PO)))
      : Promise.resolve([]),
    receivedByLine(),
    gatesFor(rows.map((x) => ({ ...x.r, createdAt: x.r.createdAt }))),
  ]);
  const poOf = new Map<string, ReqView["po"]>();
  lines
    .sort((a, b) => +a.createdAt - +b.createdAt)
    .forEach((x) =>
      poOf.set(x.l.requisitionId, {
        id: x.l.poId,
        number: x.number,
        name: poName({ poNumber: x.number, qmPoNo: x.qm }),
        source: x.source,
        status: x.status,
        lineId: x.l.id,
        ordered: x.l.quantity,
        received: received.get(x.l.id) ?? 0,
        ratePaise: x.l.ratePaise,
        gstBp: x.l.gstBp,
        drums: x.l.drums,
        supplier: x.supplier,
      }),
    );
  return rows.map((x) => {
    const rule = (x.r.purchaseRule ?? x.itemRule) as PurchaseMethod;
    /* From before the rule and already ordered the old way — or a finished good, which is made, never bought. */
    const legacy = (!x.r.purchaseRule && !poOf.get(x.r.id) && ["Order Placed", "Booked", "Received"].includes(x.r.status)) || !!x.r.productId;
    const method = (x.r.method ?? (rule !== "buyer" ? rule : null)) as ReqView["method"];
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
      po: poOf.get(x.r.id) ?? null,
      legacy,
      by: x.by,
      stock: gates.get(x.r.id) ?? null,
    };
  });
}

/**
 * THE BLIND COUNT COMES FIRST: no method, vendor, quotation or PO for a
 * requirement while its count has not been ENTERED — the same answer the
 * list draws, asked again by every handler, because a server action is a
 * URL. What the count found never holds it: a difference is a flag.
 */
export function heldByStock(v: ReqView): Result<unknown> | null {
  if (v.po || v.legacy || !v.stock?.gate.blocks) return null;
  return err(`Waiting for the blind count — ${v.stock.gate.next ?? "count the stock first"}`, "rule_violation");
}

export function stageOf(v: ReqView): Stage {
  return requirementStage({
    status: v.r.status,
    rule: v.rule,
    method: v.method,
    supplierId: v.r.supplierId,
    po: v.po ? { status: v.po.status, ordered: v.po.ordered, received: v.po.received } : null,
    legacy: v.legacy,
    gate: v.stock?.gate ?? null,
  });
}

/** Requirement ids by the work waiting on them — the dashboard tiles and the sidebar badge read these. */
export async function requirementWork(ctx?: Pick<ErpContext, "department" | "user">): Promise<Record<string, { id: string; godown: string }[]>> {
  const views = await requirementViews();
  const out: Record<string, { id: string; godown: string }[]> = {};
  /* A departmental person counts only the requirements on their own list. */
  for (const v of views.filter((x) => !ctx || requirementVisibleTo(ctx.department, x.r.department, x.r.createdById === ctx.user.id))) {
    const s = stageOf(v).stage;
    (out[s] ??= []).push({ id: v.r.id, godown: v.godown });
  }
  return out;
}

/** Stages somebody has to act on before a PO exists. */
export const REQUIREMENT_ACTION_STAGES = ["Waiting for PO number", "Create PO", "Create or link PO"];

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

export function poOption(p: { po: { poNumber: number; qmPoNo?: string | null }; supplier: string }): string {
  return `${poName(p.po)} · ${p.supplier}`;
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
export async function requisitionForm(ctx: ErpContext, init?: Record<string, string>, editing?: ReqView): Promise<FormSpec> {
  const [mats, gds, rm, allTypes, sups] = await Promise.all([
    materials(),
    godownOptions(ctx, { lost: false }),
    rmLots(),
    refValues("materialType"),
    db.select({ id: erpSuppliers.id, name: erpSuppliers.name }).from(erpSuppliers),
  ]);
  const supName = new Map(sups.map((s) => [s.id, s.name]));
  /* A category with no active item is not offered, so the form never opens onto an empty list. */
  const types = allTypes.filter((t) => mats.some((m) => m.materialType === t));
  /* A requirement is raised by one of the four teams, and the team decides the
     categories it may ask for; somebody in one team raises for it only
     (`lib/erp/departments.ts`). A requirement raised under an older label
     keeps it while it is edited. */
  const offered = requirementDepartmentsFor(ctx.department);
  const legacy = editing?.r.department && !offered.includes(editing.r.department) ? [editing.r.department] : [];
  const departments = [...offered, ...legacy];
  const typesBy: Record<string, string[]> = Object.fromEntries([...offered.map((d) => [d, categoriesFor(d, types)]), ...legacy.map((d) => [d, [editing!.itemType]])]);
  /* Each item is picked by one label — its name, or "name · category" where two categories share it. */
  const labels = itemPickLabels(mats);
  const labelOf = new Map([...labels].map(([l, x]) => [`${x.type}|${x.name}`, l]));
  const map: Record<string, string[]> = {};
  const unitOf: Record<string, string> = {};
  const ruleOf: Record<string, string> = {};
  const ruleShortOf: Record<string, string> = {};
  const typeOf: Record<string, string> = {};
  for (const m of mats) {
    const label = labelOf.get(`${m.materialType}|${m.name}`)!;
    (map[m.materialType] ??= []).push(label);
    unitOf[label] = purchaseUnit(m.unit, m.materialType);
    typeOf[label] = m.materialType;
    const rule = m.purchaseMethod as PurchaseMethod;
    const vendor = m.preferredSupplierId ? supName.get(m.preferredSupplierId) : null;
    ruleOf[label] =
      rule === "direct"
        ? `Direct purchase${vendor ? ` · ${vendor} is offered as the vendor` : " · a vendor is chosen next"}`
        : rule === "quotation"
          ? "Quotation required · quotations are collected and compared before the PO"
          : "Buyer decision · the buyer chooses direct purchase or quotations";
    ruleShortOf[label] = rule === "direct" ? `Direct${vendor ? ` · ${vendor}` : ""}` : rule === "quotation" ? "Quotations" : "Buyer decides";
  }
  /* Every item the department may ask for, across its categories — a requirement lists them all in one table. */
  const itemsBy: Record<string, string[]> = Object.fromEntries(
    departments.map((d) => [d, typesBy[d].flatMap((t) => map[t] ?? []).sort((a, b) => a.localeCompare(b))]),
  );
  const stockOf: Record<string, { lot: string; godown: string; qty: number; unit: string }[]> = {};
  rm.filter((l) => l.stock > 0).forEach((l) => {
    const label = labelOf.get(`${l.materialType}|${l.item}`) ?? l.item;
    (stockOf[label] ??= []).push({ lot: l.lotNo, godown: l.godown, qty: l.stock, unit: l.unit });
  });
  const data = { stockOf, unitOf, ruleOf, ruleShortOf, typeOf };
  const r = editing?.r;
  if (editing) {
    const label = labelOf.get(`${editing.itemType}|${editing.item}`) ?? editing.item;
    return {
      screen: "requisitions",
      id: "edit",
      recordId: r!.id,
      title: `Edit ${r!.reqNo ? `${requirementLabel(r!.reqNo)} · ` : ""}${editing.item}`,
      sub: "The item and its purchase rule are fixed; the rest can change until it is on a PO.",
      submit: "Save item",
      init: {
        date: r!.reqDate,
        requiredBy: r!.requiredBy ?? "",
        department: r!.department ?? "",
        godown: editing.godown,
        type: editing.itemType,
        item: label,
        required: String(r!.requiredQty),
        priority: r!.priority,
        remarks: r!.remarks ?? "",
      },
      data,
      header: [
        { k: "date", l: "Date", t: "date", req: true, sec: "Requirement" },
        { k: "requiredBy", l: "Required by", t: "date", req: true, hint: "The date the department needs the goods in hand." },
        { k: "department", l: "Department", t: "select", req: true, opts: departments },
        { k: "godown", l: "Deliver to godown", t: "select", req: true, opts: gds.map((g) => g.name) },
        { k: "item", l: "Item", t: "select", req: true, opts: [label], readOnly: true, sec: "Item" },
        { k: "rule", l: "Purchase rule", t: "derived", calc: "requisitions.rule" },
        { k: "onHand", l: "Available stock", t: "derived", calc: "requisitions.onHand" },
        { k: "required", l: "Quantity", t: "num", req: true, min: 0.001 },
        { k: "unit", l: "Unit", t: "derived", calc: "requisitions.unit" },
        { k: "priority", l: "Priority", t: "select", req: true, opts: ["Urgent", "Medium", "For Stock"] },
        { k: "remarks", l: "Remarks", t: "area", mic: true },
      ],
    };
  }
  /* Opened from a re-order level (or the Departments page): the item it names starts as the first line. */
  const start = init?.item ? labelOf.get(`${init.type ?? ""}|${init.item}`) ?? (labels.has(init.item) ? init.item : null) : null;
  const headerInit = Object.fromEntries(Object.entries(init ?? {}).filter(([k]) => !["item", "required", "type"].includes(k)));
  return {
    screen: "requisitions",
    id: "new",
    title: "New purchase requirement",
    sub: "Every item the department needs.",
    submit: "Raise requirement",
    init: { date: today(), godown: ctx.workingGodown?.name ?? "", priority: "Medium", ...(offered.length === 1 ? { department: offered[0] } : {}), ...headerInit },
    initLines: start ? [{ item: start, required: init?.required ?? "" }] : undefined,
    data,
    header: [
      { k: "date", l: "Date", t: "date", req: true },
      { k: "requiredBy", l: "Required by", t: "date", req: true, hint: "When the department needs the goods in hand." },
      {
        k: "department",
        l: "Department",
        t: "select",
        req: true,
        opts: departments,
        readOnly: offered.length === 1,
        hint: offered.map((d) => `${d}: ${categoriesForDepartment(d).join(", ").toLowerCase()}`).join(" · "),
      },
      { k: "godown", l: "Deliver to", t: "select", req: true, opts: gds.map((g) => g.name) },
      { k: "priority", l: "Priority", t: "select", req: true, opts: ["Urgent", "Medium", "For Stock"] },
      { k: "remarks", l: "Remarks", t: "area", mic: true },
    ],
    line: [
      { k: "item", l: "Item", t: "select", req: true, optsBy: { by: "department", map: itemsBy } },
      { k: "stock", l: "In stock", t: "derived", calc: "requisitions.stockShort" },
      { k: "required", l: "Quantity", t: "num", req: true, min: 0.001 },
      { k: "unit", l: "Unit", t: "derived", calc: "requisitions.unit" },
      { k: "rule", l: "Goes to", t: "derived", calc: "requisitions.ruleShort" },
    ],
    lineLabel: "Item",
    lineLayout: "table",
    lineAdd: {
      field: "item",
      qty: "required",
      placeholder: "Add an item — type to search",
      pasteHint: "One item a row, its quantity last: \"Toluene, 200\" or copied straight from Excel.",
    },
  };
}

/* ------------------------------------------------- the stock check, per row */

const GATE_WORDS: Record<string, string> = {
  to_count: "Waiting for the blind count",
  flagged: "Red flag — the count differs from the book; stock control is told",
  over_justified: "Counted — more is asked for than the shelf needs",
  clear: "Counted and matched",
};

function countHref(g: GateInfo): string | null {
  if (!g.count) return null;
  const tab = g.count.status === "open" ? "countTasks" : ["flagged", "recount", "investigating"].includes(g.count.status) ? "stockFlags" : "stockCounts";
  return erpLink(tab, { open: g.count.id });
}

function stockFacts(v: ReqView): { l: string; v: string; href?: string }[] {
  const g = v.stock;
  if (!g) return [];
  const out: { l: string; v: string; href?: string }[] = [
    { l: "Blind count", v: `${GATE_WORDS[g.gate.state] ?? g.gate.state}${g.count ? ` · ${countLabel(g.count.countNo)}` : ""}`, href: countHref(g) ?? undefined },
  ];
  if (g.onShelf != null) out.push({ l: "On the shelf", v: `${nf(g.onShelf)} ${g.unit}` });
  if (g.justification) out.push({ l: "Quantity the shelf needs", v: g.justification.sentence });
  /* Written under the rules before the count stopped holding the purchase; kept as the record they are. */
  if (v.r.qtyConfirmNote) out.push({ l: "Quantity confirmed because", v: v.r.qtyConfirmNote });
  if (v.r.stockExceptionReason) out.push({ l: "Urgent purchase", v: `${v.r.stockExceptionStatus === "approved" ? "Approved" : v.r.stockExceptionStatus === "rejected" ? "Rejected" : "Requested"} — ${v.r.stockExceptionReason}${v.r.stockExceptionNote ? ` · ${v.r.stockExceptionNote}` : ""}` });
  return out;
}

/** The count's own way in from the requirement: count it while it waits, open the red flag once it is in. */
function stockActions(v: ReqView): ActionSpec[] {
  const g = v.stock as GateInfo;
  const href = countHref(g);
  if (g.gate.state === "to_count") {
    if (href && g.count?.status === "open") return [{ id: "openCount", l: "Count the stock", primary: true, href }];
    return [{ id: "newCount", l: "Open a count", primary: true, confirm: `Open a blind count of ${v.item} at ${v.godown}?` }];
  }
  if (g.gate.state === "flagged" && href) return [{ id: "openCount", l: `Open the red flag (${countLabel(g.count!.countNo)})`, href }];
  return [];
}

/** What the Create PO modal is handed: the choices once per list, the requirement's own figures per row. */
export type CreatePoChoices = {
  vendors: { name: string; terms: string | null }[];
  /** Supplier id → name, for the item's default vendor. Server-side only. */
  nameOf: Map<string, string>;
  godowns: string[];
  terms: string[];
  gstPercent: number;
  canCreate: boolean;
};

const VERDICT: Record<string, "passed" | "red" | "waiting"> = { clear: "passed", over_justified: "passed", flagged: "red", to_count: "waiting" };

function flowPanel(v: ReqView, st: Stage, money: boolean, choices: CreatePoChoices, prices: Map<string, number | null>) {
  const route = poRouteOf({ rule: v.rule, method: v.method });
  const g = v.stock;
  const c = g?.comparison ?? null;
  const unit = g?.unit ?? "";
  const q = (n: number) => `${nf(n)} ${unit}`;
  const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${nf(Math.abs(n))} ${unit}`;
  const open = st.step >= 0 && !v.po && !v.legacy && !!v.r.rawMaterialId;
  const held = !!g?.gate.blocks;
  const price = v.r.rawMaterialId ? (prices.get(v.r.rawMaterialId) ?? null) : null;
  const defaultVendor = v.preferredSupplierId ? (choices.nameOf.get(v.preferredSupplierId) ?? null) : null;
  const rateBp = choices.gstPercent * 100;
  const fig = poTotals([{ quantity: v.r.requiredQty, ratePaise: price ?? 0, gstBp: rateBp }], 0);
  return {
    kind: "purchaseFlow",
    covers: ["reqNo", "method", "stage", "vendor", "po"],
    data: {
      id: v.r.id,
      steps: FLOW_STEPS,
      step: st.step,
      stage: st.stage,
      next: st.next,
      facts: [
        ...(v.r.reqNo ? [{ l: "Requirement", v: requirementLabel(v.r.reqNo) }] : []),
        ...stockFacts(v),
        { l: "Purchase method · the item's rule", v: route === "link" ? "Quotation — bought on the Quotation manager" : route === "create" ? "Direct purchase — no quotation" : "Buyer decision — create or link" },
        ...(v.r.methodNote ? [{ l: "Buyer's note", v: v.r.methodNote }] : []),
        ...(v.r.cancelReason ? [{ l: "Cancelled because", v: v.r.cancelReason }] : []),
      ],
      comparison: c
        ? {
            count: g?.count ? countLabel(g.count.countNo) : null,
            counted: g?.onShelf != null ? q(g.onShelf) : "—",
            book: q(c.book),
            pendingIn: signed(c.pendingIn),
            pendingOut: c.pendingOut ? signed(-c.pendingOut) : null,
            reconciled: q(c.reconciled),
            difference: `${signed(c.difference)}${c.reconciled ? ` (${c.difference >= 0 ? "+" : "−"}${nf(Math.round((Math.abs(c.difference) / c.reconciled) * 1000) / 10)}%)` : ""}`,
            tolerance: `± ${q(c.tolerance)}`,
          }
        : null,
      verdict: g ? (VERDICT[g.gate.state] ?? null) : null,
      po: v.po
        ? {
            name: v.po.name,
            fromQuotationManager: v.po.source === "quotation_manager",
            status: v.po.status,
            vendor: v.po.supplier,
            rate: money ? inrRate(v.po.ratePaise) : null,
            gst: `${v.po.gstBp / 100}%`,
            drums: v.po.drums,
            received: `${nf(v.po.received)} of ${nf(v.po.ordered)} ${v.r.unit}`,
            href: erpLink("purchaseOrders", { open: v.po.id }),
            canUnlink: v.po.source === "quotation_manager" && v.po.received === 0,
          }
        : null,
      entry:
        open && v.r.status !== "Cancelled"
          ? {
              held,
              link: route !== "create",
              create:
                route !== "link"
                  ? {
                      why: choices.canCreate ? "" : "Purchase orders is not on your account",
                      item: v.item,
                      reqNo: v.r.reqNo ? requirementLabel(v.r.reqNo) : null,
                      qty: String(v.r.requiredQty),
                      unit: v.r.unit,
                      godown: v.godown,
                      requiredBy: v.r.requiredBy,
                      vendor: defaultVendor ?? "",
                      defaultVendor,
                      hasPrice: price != null,
                      ratePaise: money ? (price ?? 0) : null,
                      rate: money ? inrRate(price ?? 0) : null,
                      amountPaise: money ? fig.amountPaise : null,
                      gstPercent: choices.gstPercent,
                      vendors: choices.vendors,
                      godowns: choices.godowns,
                      terms: choices.terms,
                      money,
                    }
                  : null,
            }
          : null,
    },
  };
}

/** Cancels one requirement item with a reason — the ERP's own Cancel, for the factory floor. */
export async function cancelRequirementItem(ctx: ErpContext, id: string, reason: string): Promise<Result<unknown>> {
  return requisitions.actions!.cancel(ctx, id, { reason });
}

const requisitions: ScreenModule = {
  key: "requisitions",
  async load(ctx) {
    const [views, config, form, present, sups, gds, terms, priceRows] = await Promise.all([
      requirementViews(),
      getConfig(),
      requisitionForm(ctx),
      presentQuantities(),
      db.select({ id: erpSuppliers.id, name: erpSuppliers.name, credit: erpSuppliers.creditDays }).from(erpSuppliers).where(eq(erpSuppliers.active, true)).orderBy(asc(erpSuppliers.name)),
      godownOptions(ctx, { lost: false }),
      refValues("paymentTerms"),
      db.select({ id: erpRawMaterials.id, p: erpRawMaterials.pricePaise }).from(erpRawMaterials),
    ]);
    /* What Create PO offers, read once for the list: the vendors, where to deliver, the terms, and each item's price in Raw materials. */
    const choices: CreatePoChoices = {
      vendors: sups.map((x) => ({ name: x.name, terms: x.credit ? `${x.credit} days credit` : null })),
      nameOf: new Map(sups.map((x) => [x.id, x.name])),
      godowns: gds.map((g) => g.name),
      terms,
      gstPercent: config["erp.purchase.poGstPercent"],
      canCreate: ctx.screens.has("purchaseOrders"),
    };
    const prices = new Map(priceRows.map((x) => [x.id, x.p == null ? null : Number(x.p)]));
    const money = ctx.powers.has("viewPurchaseMoney");
    const day = today();
    const cols: ColSpec[] = [
      { k: "reqNo", l: "Requirement", t: "mono" },
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
        const st = stageOf(v);
        const r = v.r;
        const actions: ActionSpec[] = [];
        const open = st.step >= 0 && !v.po && !v.legacy;
        const held = open && !!v.stock?.gate.blocks;
        if (open && v.stock) actions.push(...stockActions(v));
        if (v.po) actions.push({ id: "openPo", l: `Open ${v.po.name}`, href: erpLink("purchaseOrders", { open: v.po.id }) });
        if (open) actions.push({ id: "edit", l: "Edit", loadsForm: true });
        if (st.step >= 0 && st.step < FLOW_STEPS.length && (!v.po || v.legacy))
          actions.push({
            id: "cancel",
            l: "Cancel requirement",
            prompt: { title: "Cancel this requirement", sub: `${v.item} · ${nf(r.requiredQty)} ${r.unit}`, submit: "Cancel requirement", fields: [{ k: "reason", l: "Reason", t: "area", req: true }] },
          });
        else if (v.po && st.step >= 0 && st.step < FLOW_STEPS.length)
          actions.push({ id: "cancel", l: "Cancel requirement", why: `It is on ${v.po.name} — cancel or send back the PO first` });
        const flags: string[] = [];
        if (held) flags.push("stockToCount");
        if (open && v.stock?.gate.flag) flags.push(v.stock.gate.flag);
        if (r.requiredBy && r.requiredBy < day && st.step >= 0 && st.step < FLOW_STEPS.length) flags.push("requiredOverdue");
        if (v.legacy) flags.push("noPo");
        return {
          id: r.id,
          v: {
            reqNo: r.reqNo ? requirementLabel(r.reqNo) : null,
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
            method: methodLabel(v.method ?? v.rule),
            stage: st.stage,
            vendor: v.supplier,
            po: v.po ? v.po.name : null,
            remarks: r.remarks,
          },
          flags,
          title: v.item,
          header: `${r.reqNo ? `${requirementLabel(r.reqNo)} · ` : ""}${nf(r.requiredQty)} ${r.unit} · ${v.godown}${r.department ? ` · ${r.department}` : ""} · ${st.next}`,
          actions,
          panel: flowPanel(v, st, money, choices, prices),
          by: stampLine(v.by, r.createdAt),
        };
      });
    return {
      spec: {
        screen: "requisitions",
        cols,
        hidden: [],
        groups: ["reqNo"],
        groupHead: ["date", "department", "godown"],
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
  },
  forms: {
    async new(ctx, h, lines) {
      return raiseRequirement(ctx, h, lines ?? []);
    },
    async edit(ctx, h, _l, id) {
      return saveRequirement(ctx, h, id);
    },
  },
  actions: {
    /* The PO, by the item's purchase rule (`requirement-po.ts`): link the Quotation manager's number, or create one at the item's price. */
    async linkPo(ctx, id, values) {
      return (await import("./requirement-po")).linkRequirementPo(ctx, id, values.poNo ?? "");
    },
    async unlinkPo(ctx, id) {
      return (await import("./requirement-po")).unlinkRequirementPo(ctx, id);
    },
    async createPo(ctx, id, values) {
      return (await import("./requirement-po")).createRequirementPo(ctx, id, values);
    },
    async newCount(ctx, id) {
      const [v] = await requirementViews({ ids: [id] });
      if (!v?.r.rawMaterialId) return err("That requirement no longer exists.", "not_found");
      const label = v.r.reqNo ? requirementLabel(v.r.reqNo) : "a requirement";
      await db.transaction((tx) => openRequirementCounts(tx, [{ id, rawMaterialId: v.r.rawMaterialId!, godownId: v.r.godownId, label }], ctx.user.id));
      await erpAudit(ctx, "erp.requisition.newCount", "erp_requisition", id, null, null);
      return okVoid("A blind count is open — it is on Stock accuracy → To count");
    },
    async decide(ctx, id, values) {
      if (!ctx.powers.has("purchaseBuyer")) return err("Only the buyer decides how a requirement is bought.", "not_permitted");
      const m = methodByLabel(text(values.method));
      if (m !== "direct" && m !== "quotation") return fieldErr("method", "Choose direct purchase or quotation");
      const [v] = await requirementViews({ ids: [id] });
      if (!v) return err("That requirement no longer exists.", "not_found");
      const held = heldByStock(v);
      if (held) return held;
      if (stageOf(v).stage !== "Buyer decision") return err("This requirement's method is already decided.", "conflict");
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
      return okVoid(m === "direct" ? `Direct purchase${preset ? " · the item's default vendor is offered" : " · select the vendor next"}` : "Quotation · buy it on the Quotation manager, then link its PO number here");
    },
    async vendor(ctx, id, values) {
      const [sup] = await db.select().from(erpSuppliers).where(and(eq(erpSuppliers.name, text(values.vendor) ?? ""), eq(erpSuppliers.active, true)));
      if (!sup) return fieldErr("vendor", "Pick an active vendor");
      const [v] = await requirementViews({ ids: [id] });
      if (!v) return err("That requirement no longer exists.", "not_found");
      if (v.r.status === "Cancelled") return err("This requirement is cancelled.", "conflict");
      if (v.po) return err(`It is on ${v.po.name} — the vendor is the PO's now.`, "conflict");
      if (v.method !== "direct") return err("Only a direct purchase has its vendor picked; a quotation item's vendor comes with the Quotation manager's PO.", "rule_violation");
      const held = heldByStock(v);
      if (held) return held;
      await db
        .update(erpRequisitions)
        .set({ method: "direct", supplierId: sup.id, vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpRequisitions.id, id));
      await erpAudit(ctx, "erp.requisition.selectVendor", "erp_requisition", id, { supplierId: v.r.supplierId }, { supplierId: sup.id });
      return okVoid(`${sup.name} is the vendor · raise the PO next`);
    },
    async cancel(ctx, id, values) {
      const reason = text(values.reason);
      if (!reason) return fieldErr("reason", "Say why it is cancelled");
      const [v] = await requirementViews({ ids: [id] });
      if (!v) return err("That requirement no longer exists.", "not_found");
      if (!requirementVisibleTo(ctx.department, v.r.department, v.r.createdById === ctx.user.id)) return err("That requirement belongs to another department.", "not_permitted");
      if (v.r.status === "Cancelled") return err("Already cancelled.", "conflict");
      if (v.po) return err(`It is on ${v.po.name} — cancel or send back the PO first.`, "conflict");
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
    /* An older requirement may keep the label it was raised under; moving it is held to the four. */
    const refusedEdit = department === v.r.department ? null : requirementRefusal(ctx.department, department, v.itemType);
    if (refusedEdit) return fieldErr(refusedEdit.field, refusedEdit.message);
    const values = { reqDate: date, requiredBy, department, godownId, requiredQty: qty, priority, remarks: text(h.remarks), updatedAt: new Date(), updatedById: ctx.user.id };
    await db.update(erpRequisitions).set(values).where(eq(erpRequisitions.id, id));
    await erpAudit(ctx, "erp.requisition.edit", "erp_requisition", id, v.r, values);
    return okVoid("Requirement saved");
  }
  return err("A new requirement is raised with its items.", "validation");
}

/** The requirement's own answers, shared by every item raised on it. */
function requirementHeader(h: Record<string, string>): Result<{ date: string; requiredBy: string; department: string; priority: string; remarks: string | null }> {
  const requiredBy = text(h.requiredBy);
  if (!requiredBy) return fieldErr("requiredBy", "Required by is required");
  const date = text(h.date) ?? today();
  if (requiredBy < date) return fieldErr("requiredBy", "Required by cannot be before the requirement's date");
  const department = text(h.department);
  if (!department) return fieldErr("department", "Department is required");
  const priority = text(h.priority) ?? "Medium";
  if (!["Urgent", "Medium", "For Stock"].includes(priority)) return fieldErr("priority", "Priority is required");
  return ok({ date, requiredBy, department, priority, remarks: text(h.remarks) });
}

/**
 * RAISE A REQUIREMENT: one number, every item the department needs. Each item
 * is its own row — its method, quotations, vendor and PO line are decided per
 * item — and all of them are written in ONE transaction under one requirement
 * number, so a requirement is never half raised. Every line is checked before
 * anything is written, and a refusal names the line it is about.
 *
 * A header that names one item itself (`type`, `item`, `required`) and sends
 * no lines is a requirement of one item — the shape every caller used before a
 * requirement could carry several.
 */
async function raiseRequirement(ctx: ErpContext, h: Record<string, string>, rawLines: Record<string, string>[]): Promise<Result<unknown>> {
  const res = await raiseRequirementWith(ctx, h, rawLines);
  return res.ok ? okVoid(res.message) : res;
}

/** One item of a requirement just raised, and what the count raised with it found. */
export type RaisedItem = {
  id: string;
  rawMaterialId: string;
  item: string;
  qty: number;
  unit: string;
  rule: PurchaseMethod;
  /** The count the raiser made with it: matched, a red flag, or not recorded (a recount of that shelf was already open). Null: none was sent. */
  count: { id: string; countNo: number; verdict: "matched" | "flagged" | "skipped" } | null;
};

/**
 * Raises a requirement, and — where `counts` names an item's raw material —
 * records the raiser's count of it at the godown as that item's stock check,
 * in the same transaction. The count is the ordinary blind count the
 * requirement waits on (`openRequirementCounts`), written and judged by
 * `writeCounted`, the same function Stock accuracy submits through. It is
 * recorded whether or not `erp.stockCheck.onRequirement` holds the purchase:
 * a figure somebody counted is evidence either way.
 *
 * A line may name its item by label (`item`, the ERP form) or by raw material
 * id (`rawMaterialId`, the factory phone).
 */
export async function raiseRequirementWith(
  ctx: ErpContext,
  h: Record<string, string>,
  rawLines: Record<string, string>[],
  counts?: Map<string, number>,
): Promise<Result<{ reqNo: number; items: RaisedItem[] }>> {
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const head = requirementHeader(h);
  if (!head.ok) return head;
  const { date, requiredBy, department, priority, remarks } = head.data;

  const single = !rawLines.some((l) => text(l.item) || text(l.rawMaterialId) || text(l.required)) && (text(h.item) || text(h.type));
  const lines: Record<string, string>[] = single
    ? [{ item: text(h.item) ?? "", required: h.required ?? "", type: text(h.type) ?? "" }]
    : rawLines.filter((l) => text(l.item) || text(l.rawMaterialId) || text(l.required));
  if (!lines.length) return err("Add at least one item to the requirement.", "validation");
  const cap = 500;
  if (lines.length > cap) return err(`A requirement carries at most ${cap} items — split this one in two.`, "validation");

  const [mats, categories] = await Promise.all([materials(), refValues("materialType")]);
  const labels = itemPickLabels(mats);
  const byKey = new Map(mats.map((m) => [`${m.materialType}|${m.name}`, m]));
  /* A line's field, as the form knows it: `item` on a single-item header, `l3.item` on line 4. */
  const at = (i: number, k: string) => (single ? (k === "required" ? "required" : k) : `l${i}.${k}`);
  const seen = new Map<string, number>();
  const items: { m: typeof mats[number]; qty: number }[] = [];
  const byId = new Map(mats.map((m) => [m.id, m]));
  for (const [i, l] of lines.entries()) {
    const idPick = text(l.rawMaterialId);
    if (idPick) {
      const m = byId.get(idPick);
      if (!m) return fieldErr(at(i, "item"), "That item is no longer active");
      const refused = requirementRefusal(ctx.department, department, m.materialType);
      if (refused) return fieldErr(at(i, "item"), refused.message);
      const qty = num(l.required);
      if (qty == null || qty <= 0) return fieldErr(at(i, "required"), qty != null && qty < 0 ? "Minus Quantity Not Allowed" : "Quantity is required");
      if (seen.has(m.id)) return fieldErr(at(i, "item"), `Already on line ${seen.get(m.id)! + 1} — change that line's quantity instead`);
      seen.set(m.id, i);
      items.push({ m, qty });
      continue;
    }
    const pick = text(l.item);
    if (!pick) return fieldErr(at(i, "item"), "Item is required");
    /* Finished goods are made, not bought: only the item master's categories may be asked for. */
    const type = "type" in l && l.type ? l.type : labels.get(pick)?.type;
    if (single && (!type || !categories.includes(type))) return fieldErr("type", "Category is required");
    const name = labels.get(pick)?.name ?? pick;
    const m = type ? byKey.get(`${type}|${name}`) : undefined;
    if (!m) return fieldErr(at(i, "item"), single ? "Pick an item of this category" : `"${pick}" is not an active item`);
    const refused = requirementRefusal(ctx.department, department, m.materialType);
    if (refused) return fieldErr(refused.field === "type" && !single ? at(i, "item") : refused.field, refused.message);
    const qty = num(l.required);
    if (qty == null || qty <= 0) return fieldErr(at(i, "required"), qty != null && qty < 0 ? "Minus Quantity Not Allowed" : "Quantity is required");
    if (seen.has(m.id)) return fieldErr(at(i, "item"), `Already on line ${seen.get(m.id)! + 1} — change that line's quantity instead`);
    seen.set(m.id, i);
    items.push({ m, qty });
  }

  /* Copied onto each row, like the purchase rule: changing the setting never re-routes a requirement in flight. */
  const stockCheck = (await getConfig())["erp.stockCheck.onRequirement"];
  const raisedItems: RaisedItem[] = [];
  /* Red flags found by the raiser's counts, told to stock control once the requirement is saved. */
  const alarms: Parameters<typeof notifyStockFlag>[0][] = [];
  const reqNo = await db.transaction(async (tx) => {
    const n = await nextNumber(tx, "requirement");
    const raised: { id: string; rawMaterialId: string; godownId: string; label: string }[] = [];
    for (const { m, qty } of items) {
      const reqId = erpId("req");
      raised.push({ id: reqId, rawMaterialId: m.id, godownId, label: requirementLabel(n) });
      /* CHECK PURCHASE RULE: copied onto the item now, so changing the rule later never re-routes it. */
      const rule = m.purchaseMethod as PurchaseMethod;
      const preset = rule === "direct" && m.preferredSupplierId ? m.preferredSupplierId : null;
      await tx.insert(erpRequisitions).values({
        id: reqId,
        reqNo: n,
        reqDate: date,
        requiredBy,
        department,
        godownId,
        materialType: m.materialType,
        rawMaterialId: m.id,
        unit: purchaseUnit(m.unit, m.materialType),
        requiredQty: qty,
        priority,
        remarks,
        purchaseRule: rule,
        method: rule === "buyer" ? null : rule,
        ...(preset ? { supplierId: preset, vendorSelectedAt: new Date(), vendorSelectedById: ctx.user.id } : {}),
        stockCheckRequired: stockCheck,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
    }
    /* INVENTORY ACCURACY CONTROL: the blind count each item waits on, opened in the same act. */
    if (stockCheck) await openRequirementCounts(tx, raised, ctx.user.id);
    for (const [i, r] of raised.entries()) {
      const { m, qty } = items[i];
      const counted = counts?.get(m.id);
      let count: RaisedItem["count"] = null;
      if (counted != null) {
        const c = await openCount(tx, { kind: "reorder", rawMaterialId: m.id, godownId, requisitionId: r.id, reason: `Before purchase — ${r.label}`, byId: ctx.user.id });
        const [row] = (await tx.execute(sql`select id, raw_material_id, godown_id, recount_of_id from erp_stock_counts where id = ${c.id} for update`)) as unknown as {
          id: string; raw_material_id: string; godown_id: string; recount_of_id: string | null;
        }[];
        /* A recount already open on the shelf is somebody else's to make: it is left for them. */
        if (row.recount_of_id) count = { id: c.id, countNo: c.countNo, verdict: "skipped" };
        else {
          const w = await writeCounted(tx, ctx.user.id, row, counted, { note: `Counted with ${r.label}` });
          count = { id: c.id, countNo: c.countNo, verdict: w.status === "matched" ? "matched" : "flagged" };
          if (w.status === "flagged")
            alarms.push({ countId: c.id, countNo: c.countNo, item: m.name, godown: w.facts.godown, counted, book: w.j.reconciled, difference: w.j.difference, unit: w.facts.unit, requirementId: r.id, byId: ctx.user.id });
        }
      }
      raisedItems.push({ id: r.id, rawMaterialId: m.id, item: m.name, qty, unit: purchaseUnit(m.unit, m.materialType), rule: m.purchaseMethod as PurchaseMethod, count });
    }
    return n;
  });
  /* A RED FLAG IS TOLD, as a count on Stock accuracy tells it; it never fails the requirement. */
  for (const a of alarms) await notifyStockFlag(a);
  await erpAudit(ctx, "erp.requisition.create", "erp_requisition", requirementLabel(reqNo), null, {
    reqNo,
    items: items.map(({ m, qty }) => ({ item: m.name, qty, rule: m.purchaseMethod })),
    priority,
  });
  if (items.length === 1) {
    const { m, qty } = items[0];
    const rule = m.purchaseMethod as PurchaseMethod;
    const next =
      rule === "buyer"
        ? "the buyer decides how it is bought"
        : rule === "quotation"
          ? "buy it on the Quotation manager, then link its PO number"
          : m.preferredSupplierId
            ? "direct purchase from the item's default vendor — raise the PO next"
            : "direct purchase — select the vendor next";
    return ok(
      { reqNo, items: raisedItems },
      `${requirementLabel(reqNo)} raised · ${m.name} · ${nf(qty)} ${purchaseUnit(m.unit, m.materialType)} · ${stockCheck ? "count the stock first, then " : ""}${next}`,
    );
  }
  const count = (r: string) => items.filter((x) => x.m.purchaseMethod === r).length;
  const split = [
    count("direct") ? `${count("direct")} direct` : "",
    count("quotation") ? `${count("quotation")} by quotation` : "",
    count("buyer") ? `${count("buyer")} for the buyer` : "",
  ].filter(Boolean);
  return ok({ reqNo, items: raisedItems }, `${requirementLabel(reqNo)} raised · ${items.length} items · ${split.join(" · ")}${stockCheck ? " · each waits on a stock count" : ""}`);
}

/* ===================================================== requirement labels */

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

/* ======================================================== purchase orders */

/** Everything the PO form needs: requirements ready for a PO (or already on the one being edited), by vendor. */
async function poFormData(editingPoId?: string) {
  const views = await requirementViews();
  const eligible = views.filter((v) => stageOf(v).readyForPo || (editingPoId && v.po?.id === editingPoId));
  return { eligible, map: labelled(eligible) };
}

export async function purchaseOrderForm(ctx: ErpContext, opts: { supplierId?: string; focus?: string; poId?: string } = {}): Promise<FormSpec | null> {
  const [{ map }, gds, sups, terms] = await Promise.all([
    poFormData(opts.poId),
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
  map.forEach((v, l) => {
    const vendor = supById.get(v.r.supplierId ?? "")?.name;
    if (!vendor) return;
    (byVendor[vendor] ??= []).push(l);
    qtyOf[l] = String(v.r.requiredQty);
    itemOf[l] = v.item;
    unitOf[l] = v.r.unit;
    gstOf[l] = "18";
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
  const vendorTerms = vendor?.creditDays ? `${vendor.creditDays} days credit` : null;
  const term = po?.po.paymentTerms ?? vendorTerms ?? "";
  const deliveryInit = po?.po.deliveryDate ?? firstReq?.r.requiredBy ?? "";
  const vendors = Object.keys(byVendor).sort();
  if (vendor && !vendors.includes(vendor.name)) vendors.push(vendor.name);
  return {
    screen: "purchaseOrders",
    id: po ? "edit" : "new",
    recordId: po?.po.id,
    title: po ? `Edit ${poName(po.po)}` : "New purchase order",
    sub: po
      ? "Only a PO not yet sent or received against is edited."
      : "No approval: the PO is ready to send to the vendor and receive against as soon as it is saved.",
    submit: po ? "Save PO" : "Create PO",
    lineLabel: "Item",
    init: {
      date: po?.po.poDate ?? today(),
      vendor: vendor?.name ?? "",
      deliverTo: po?.godown ?? firstReq?.godown ?? ctx.workingGodown?.name ?? "",
      deliveryDate: deliveryInit,
      terms: term,
      freight: po ? rupeesField(po.po.freightPaise) : "",
      remarks: po?.po.remarks ?? "",
      poNo: po ? poName(po.po) : "",
    },
    initLines,
    data: { itemOf, unitOf },
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
        hint: vendors.length ? undefined : "No requirement is ready for a PO. A requirement is ready once its vendor is chosen.",
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
  const { map } = await poFormData(poId);
  const parsed: { v: ReqView; qty: number; rate: number; gstBp: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const v = map.get(text(l.requirement) ?? "");
    if (!v) return fieldErr(`l${i}.requirement`, "Pick a requirement ready for a PO");
    if (seen.has(v.r.id)) return fieldErr(`l${i}.requirement`, "This requirement is already on the PO");
    seen.add(v.r.id);
    if (v.r.supplierId !== vendor.id) return fieldErr(`l${i}.requirement`, `This requirement's vendor is not ${vendor.name}`);
    const qty = num(l.qty);
    if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, qty != null && qty < 0 ? "Minus Quantity Not Allowed" : "Quantity is required");
    const rate = paise(l.rate);
    if (rate == null || rate <= 0) return fieldErr(`l${i}.rate`, "Rate is required");
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
      if (!["Pending approval", "Approved"].includes(before.status)) refuse(err(`${poName(before)} is ${before.status} — only a PO not yet sent is edited.`, "conflict"));
      const got = await receivedByLine(tx);
      const had = await tx.select({ id: erpPoLines.id }).from(erpPoLines).where(eq(erpPoLines.poId, poId));
      if (had.some((l) => (got.get(l.id) ?? 0) > 0)) refuse(err(`Goods were received against ${poName(before)} — it is no longer edited.`, "conflict"));
      number = before.poNumber;
      await tx.update(erpPurchaseOrders).set(header).where(eq(erpPurchaseOrders.id, poId));
      await tx.delete(erpPoLines).where(eq(erpPoLines.poId, poId));
    } else {
      number = await nextNumber(tx, "po");
      /* No approval on any route (Oct 2026): a PO is ready to send and receive against once saved. */
      await tx.insert(erpPurchaseOrders).values({
        id,
        poNumber: number,
        status: "Approved",
        approvedById: ctx.user.id,
        approvedAt: new Date(),
        decisionNote: "No approval needed",
        createdById: ctx.user.id,
        ...header,
      });
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
    await refreshPurchaseOrder(tx, id);
    const t = poTotals(parsed.map((p) => ({ quantity: p.qty, ratePaise: p.rate, gstBp: p.gstBp })), freight);
    return ok({ id }, `${poLabel(number)} ${poId ? "saved" : "created"} · ${inr(t.totalPaise)} · send it to the vendor`);
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
    covers: ["items", "value", "received"],
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
      print: p.po.approvedAt && p.po.status !== "Rejected" ? erpPoHref(p.po.id) : null,
    },
  };
}

/**
 * Whether this person may decide (approve or send back) the PO: the "Approve
 * purchase orders" power, granted in the Admin Console and nowhere else.
 * Null: they may.
 */
async function approvalRefusal(ctx: ErpContext, poId: string): Promise<Result<unknown> | null> {
  const [p] = await purchaseOrderViews({ ids: [poId] });
  if (!p) return err("That PO no longer exists.", "not_found");
  if (ctx.powers.has("approvePurchaseOrder")) return null;
  return err("Only the PO approver decides a purchase order.", "not_permitted");
}

const purchaseOrders: ScreenModule = {
  key: "purchaseOrders",
  async load(ctx) {
    const [pos, form] = await Promise.all([purchaseOrderViews(), purchaseOrderForm(ctx)]);
    const money = ctx.powers.has("viewPurchaseMoney");
    /* Imported here: po-share reads this file's PO views. */
    const shareSpecs = await (await import("../po-share")).poShareSpecs(pos, money);
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
      { k: "shared", l: "Last shared", t: "t" },
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
      const approveWhy = approver ? "" : "Only the PO approver approves";
      if (s === "Pending approval") {
        actions.push({
          id: "approve",
          l: "Approve",
          primary: true,
          why: approveWhy || (self ? "You raised this PO — another approver approves it" : ""),
          prompt: { title: `Approve ${poName(p.po)}`, sub: `${p.supplier} · ${money ? inr(t.totalPaise) : `${p.lines.length} items`}`, submit: "Approve PO", fields: [{ k: "note", l: "Note", t: "area" }] },
        });
        actions.push({
          id: "sendBack",
          l: "Send back",
          why: approveWhy,
          prompt: { title: `Send back ${poName(p.po)}`, sub: "Its requirements return to Ready for PO, to be raised again corrected.", submit: "Send back", fields: [{ k: "reason", l: "What needs changing", t: "area", req: true }] },
        });
      }
      if (s === "Pending approval" || (s === "Approved" && !anyReceived)) actions.push({ id: "edit", l: "Edit", loadsForm: true, why: money ? "" : MONEY_WHY });
      if (s === "Approved" || s === "Sent" || s === "Partly received" || s === "Received") {
        actions.push({
          id: "share",
          l: "Share…",
          primary: s === "Approved",
          why: money ? "" : "The PO carries its rates, and purchase money is not on your account",
          share: shareSpecs.get(p.po.id),
        });
      }
      if (s === "Approved" || s === "Sent" || s === "Partly received") {
        actions.push({ id: "receive", l: "Receive goods", primary: s !== "Approved", loadsForm: true, why: canReceive ? "" : "Goods receipt is not on your account" });
      }
      if (s === "Partly received")
        actions.push({
          id: "close",
          l: "Close short",
          prompt: { title: `Close ${poName(p.po)} short`, sub: "Nothing more is expected against it; its requirements count as received.", submit: "Close PO", fields: [{ k: "reason", l: "Why", t: "area", req: true }] },
        });
      if (["Pending approval", "Approved", "Sent"].includes(s))
        actions.push({
          id: "cancel",
          l: "Cancel PO",
          why: anyReceived ? "Goods were received against it — close it short instead" : "",
          prompt: { title: `Cancel ${poName(p.po)}`, sub: "Its requirements return to Ready for PO, keeping their vendor.", submit: "Cancel PO", fields: [{ k: "reason", l: "Reason", t: "area", req: true }] },
        });
      if (p.po.approvedAt && s !== "Rejected") actions.push({ id: "print", l: "Print / PDF", href: erpPoHref(p.po.id) });
      const flags: string[] = [];
      if (s === "Pending approval") flags.push("awaitingApproval");
      if (RECEIVABLE_PO.includes(s) && p.po.deliveryDate < day) flags.push("deliveryLate");
      return {
        id: p.po.id,
        v: withoutHidden(
          {
            po: poName(p.po),
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
            shared: shareSpecs.get(p.po.id)?.last ?? (p.po.sentVia ? `${p.po.sentVia}${p.po.sentAt ? ` · ${fd(calendarDate(p.po.sentAt))}` : ""}` : null),
          },
          hiddenKeys,
        ),
        flags,
        title: `${poName(p.po)} · ${p.supplier}`,
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
        rowMenu: ["share", "print", "receive", "edit", "close", "cancel"],
        cols,
        hidden,
        groups: ["status"],
        chips: "status",
        newForm: money ? (form ?? undefined) : undefined,
        newLabel: "New PO",
        noDataLine: "No purchase orders yet. Create one from a direct-purchase requirement, or link one from the Quotation manager.",
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
        if (po.status !== "Pending approval") return err(`${poName(po)} is ${po.status}.`, "conflict");
        if (po.createdById === ctx.user.id && !ctx.administrator) return err("You raised this PO — another approver approves it.", "not_permitted");
        await tx
          .update(erpPurchaseOrders)
          .set({ status: "Approved", approvedById: ctx.user.id, approvedAt: new Date(), decisionNote: text(values.note), updatedAt: new Date(), updatedById: ctx.user.id })
          .where(eq(erpPurchaseOrders.id, id));
        const reqs = (await tx.select({ id: erpPoLines.requisitionId }).from(erpPoLines).where(eq(erpPoLines.poId, id))).map((r) => r.id);
        if (reqs.length) await tx.update(erpRequisitions).set({ status: "Order Placed", updatedAt: new Date() }).where(inArray(erpRequisitions.id, reqs));
        return okVoid(`${poName(po)} approved · send it to the vendor`);
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
      if (po.status !== "Pending approval") return err(`${poName(po)} is ${po.status}.`, "conflict");
      await db
        .update(erpPurchaseOrders)
        .set({ status: "Rejected", approvedById: ctx.user.id, approvedAt: new Date(), decisionNote: reason, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(and(eq(erpPurchaseOrders.id, id), eq(erpPurchaseOrders.status, "Pending approval")));
      await erpAudit(ctx, "erp.purchaseOrder.sendBack", "erp_purchase_order", id, null, { reason });
      return okVoid(`${poName(po)} sent back · its requirements are ready for a new PO`);
    },
    async share(ctx, id, values) {
      return (await import("../po-share")).sharePo(ctx, id, values ?? {});
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
        return okVoid(`${poName(po)} closed short`);
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
        if (!["Pending approval", "Approved", "Sent"].includes(po.status)) return err(`${poName(po)} is ${po.status}.`, "conflict");
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
        return okVoid(`${poName(po)} cancelled · its requirements are ready for a new PO`);
      });
      if (res.ok) await erpAudit(ctx, "erp.purchaseOrder.cancel", "erp_purchase_order", id, null, { reason });
      return res;
    },
  },
};

/** Badge counts for the sidebar: requirements waiting on somebody, and POs waiting on approval or on being sent. */
export async function purchaseFlowCounts(ctx: ErpContext): Promise<{ requisitions: number; purchaseOrders: number }> {
  const [work, pos] = await Promise.all([requirementWork(ctx), purchaseOrderViews({ status: ["Pending approval", "Approved"] })]);
  const requisitions = REQUIREMENT_ACTION_STAGES.reduce((n, s) => n + (work[s]?.length ?? 0), 0);
  const approver = ctx.powers.has("approvePurchaseOrder");
  const purchaseOrders = pos.filter(
    (p) =>
      p.po.status === "Approved" ||
      (approver && (p.po.createdById !== ctx.user.id || ctx.administrator)),
  ).length;
  return { requisitions, purchaseOrders };
}

export const PURCHASE_FLOW_SCREENS: ScreenModule[] = [requisitions, purchaseOrders];
