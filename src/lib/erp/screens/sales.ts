import "server-only";
import { randomUUID } from "node:crypto";
import { calendarDate } from "@/lib/business-date";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  erpBatchCodes,
  erpFollowups,
  erpGodowns,
  erpOrderDetails,
  erpOrders,
  erpTransports,
  priceListDiscountTerms,
  priceListRates,
  priceLists,
  products,
  users,
} from "@/db/schema";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpAudit, erpId, int, nextNumber, num, paise, rupeesField, stampLine, text, visibleCols, withoutHidden, type ScreenModule } from "../server";
import type { ActionSpec, BulkSpec, CellValue, FieldSpec, FormSpec, ListRow } from "../ui";
import { fd, inr, nf } from "../ui";
import {
  addDaysIso,
  allocationState,
  allocationTarget,
  billFigures,
  boxQuantity,
  daysBetween,
  labelCount,
  lotCosting,
  margin,
  monthId,
  orderType,
  standingInstructions,
  targetReached,
  type Allocation,
  type OrderType,
} from "../engines/sales";
import { fgLots, lockLot, packLots } from "../stock";
import { godownIdByName, godownOptions, has, inTx, refuse, today, type Col } from "./common";
import { loadCustomers, partyStatus, type CustomerRow } from "./masters";

/* ---------------------------------------------------------------------------
 * Sales orders (spec §11): the taken-order line, its lot allocations, the
 * label export and order details, where a line is billed and dispatched.
 *
 * Everything a detail line shows is read LIVE from its order line, as the
 * source reads it; the detail row holds only what dispatch adds. A lot
 * allocation takes stock the moment it is written, under the lot's lock, and
 * deleting it gives the stock back.
 * ------------------------------------------------------------------------- */

export const ORDER_STATUSES = ["Under Process", "Ready", "Today", "Delay", "Cancel", "Tomorrow", "Hold From Office"];

/* ============================================================ the lines */

type Sku = { id: string; name: string; fgId: string | null; cpb: number; litresPerCan: number; weightKg: number | null; boxType: string | null; empty: number };

async function skuCatalogue(): Promise<Map<string, Sku>> {
  const rows = (await db.execute(sql`
    select p.id, p.name, p.finished_good_id as "fgId", p.cans_per_box as cpb,
           coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as "litresPerCan",
           p.weight_grams::float8 / 1000 as "weightKg", pk.box_type as "boxType", coalesce(pk.empty_boxes_required, 0) as empty
      from products p
      left join finished_goods fg on fg.id = p.finished_good_id
      left join erp_product_packing pk on pk.product_id = p.id
  `)) as unknown as Sku[];
  return new Map(rows.map((r) => [r.id, { ...r, cpb: Number(r.cpb), litresPerCan: Number(r.litresPerCan ?? 0), empty: Number(r.empty) }]));
}

/** A boxed SKU sells from packing stock in boxes; a loose one from FG stock in cans. */
const isBoxed = (s: Sku) => s.empty > 0;

/**
 * The price-list rate and discount for a party and an SKU (spec §11.2): the
 * party's tagged list, the latest published version of it, the SKU's row —
 * or failing that a row for another SKU of the same FG product, as the source
 * looks up by FG product. The rate is the list's ex-GST rate, because order
 * details adds GST on top (decision recorded in the phase 4 PR).
 */
async function priceBook(): Promise<(tag: string | null, sku: Sku | undefined) => { ratePaise: number | null; discountBp: number | null }> {
  const lists = await db
    .select({ id: priceLists.id, name: priceLists.name, from: priceLists.effectiveFrom, status: priceLists.status })
    .from(priceLists)
    .where(eq(priceLists.status, "published"))
    .orderBy(desc(priceLists.effectiveFrom));
  const listByName = new Map<string, string>();
  for (const l of lists) if (!listByName.has(l.name.trim().toLowerCase())) listByName.set(l.name.trim().toLowerCase(), l.id);
  const ids = [...new Set(listByName.values())];
  if (!ids.length) return () => ({ ratePaise: null, discountBp: null });
  const [rates, terms] = await Promise.all([
    db
      .select({ list: priceListRates.priceListId, sku: priceListRates.productId, fg: products.finishedGoodId, rate: priceListRates.rateExGstPaise })
      .from(priceListRates)
      .leftJoin(products, eq(products.id, priceListRates.productId))
      .where(inArray(priceListRates.priceListId, ids)),
    db.select({ list: priceListDiscountTerms.priceListId, bp: priceListDiscountTerms.percentBp, t1: priceListDiscountTerms.thresholdLitres, t2: priceListDiscountTerms.thresholdPaise }).from(priceListDiscountTerms).where(inArray(priceListDiscountTerms.priceListId, ids)),
  ]);
  const bySku = new Map<string, number>();
  const byFg = new Map<string, number>();
  for (const r of rates) {
    if (r.sku) bySku.set(`${r.list}|${r.sku}`, r.rate);
    if (r.fg && !byFg.has(`${r.list}|${r.fg}`)) byFg.set(`${r.list}|${r.fg}`, r.rate);
  }
  const disc = new Map<string, number>();
  for (const t of terms) if (t.t1 == null && t.t2 == null && !disc.has(t.list)) disc.set(t.list, t.bp);
  return (tag, sku) => {
    const list = tag ? listByName.get(tag.trim().toLowerCase()) : undefined;
    if (!list || !sku) return { ratePaise: null, discountBp: null };
    const rate = bySku.get(`${list}|${sku.id}`) ?? (sku.fgId ? byFg.get(`${list}|${sku.fgId}`) : undefined) ?? null;
    return { ratePaise: rate, discountBp: disc.get(list) ?? null };
  };
}

export type OrderLine = {
  o: typeof erpOrders.$inferSelect;
  godown: string;
  billing: CustomerRow;
  delivery: CustomerRow;
  sku: Sku;
  type: OrderType;
  boxed: boolean;
  boxes: number;
  boxesValid: boolean;
  labels: number;
  allocated: number;
  allocations: number;
  allocation: Allocation;
  inDetails: boolean;
  si: string;
  liveRatePaise: number | null;
  by: string | null;
};

/** Every order line with what the screens derive from it — the one reading every sales list shares. */
export async function orderLines(): Promise<OrderLine[]> {
  const [rows, parties, skus, prices, alloc, details] = await Promise.all([
    db
      .select({ o: erpOrders, godown: erpGodowns.name, by: users.name })
      .from(erpOrders)
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpOrders.godownId))
      .leftJoin(users, eq(users.id, erpOrders.createdById))
      .orderBy(desc(erpOrders.orderNo), desc(erpOrders.orderDate), asc(erpOrders.createdAt)),
    loadCustomersAll(),
    skuCatalogue(),
    priceBook(),
    db.execute(sql`select order_id as id, sum(quantity)::float8 as qty, count(*)::int as n from erp_batch_codes group by order_id`) as unknown as Promise<{ id: string; qty: number; n: number }[]>,
    db.select({ id: erpOrderDetails.orderId }).from(erpOrderDetails),
  ]);
  const allocBy = new Map(alloc.map((a) => [a.id, a]));
  const inDetails = new Set(details.map((d) => d.id));
  const out: OrderLine[] = [];
  for (const r of rows) {
    const billing = parties.get(r.o.billingCustomerId);
    const delivery = parties.get(r.o.deliveryCustomerId) ?? billing;
    const sku = skus.get(r.o.skuId);
    if (!billing || !delivery || !sku) continue;
    const type = orderType(sku.boxType);
    const boxed = isBoxed(sku);
    const { boxes, valid } = boxQuantity(r.o.qtyCans, sku.cpb, !boxed);
    const a = allocBy.get(r.o.id);
    const allocated = a ? Number(a.qty) : 0;
    out.push({
      o: r.o,
      godown: r.godown,
      billing,
      delivery,
      sku,
      type,
      boxed,
      boxes,
      boxesValid: valid,
      labels: labelCount(type, boxes, r.o.qtyCans),
      allocated,
      allocations: a ? Number(a.n) : 0,
      allocation: allocationState(allocationTarget(boxed, boxes, r.o.qtyCans), allocated),
      inDetails: inDetails.has(r.o.id),
      si: standingInstructions({ instructions: delivery.p?.standingInstructions ?? null, deliveryType: delivery.deliveryType, paymentType: delivery.freightTerm, weightType: delivery.p?.weightType ?? null }),
      liveRatePaise: prices(billing.priceTag, sku).ratePaise,
      by: r.by,
    });
  }
  return out;
}

/** Every customer an order can name — including ones not in the ERP's own party list. */
async function loadCustomersAll(): Promise<Map<string, CustomerRow>> {
  return new Map((await loadCustomers()).map((c) => [c.id, c]));
}

/** Why a line cannot go to order details, in the order the office has to fix them. */
function detailsBlockers(l: OrderLine): string[] {
  const miss: string[] = [];
  if (l.inDetails) return ["already in order details"];
  if (l.o.status !== "Ready") miss.push("status Ready");
  if (!l.o.tallyBillNo) miss.push("a Tally bill no.");
  if (l.o.ratePaise == null) miss.push("a rate");
  if (l.o.entryStatus !== "Done") miss.push("entry Done");
  if (l.allocation !== "Done") miss.push("lots allocated in full");
  return miss;
}

function lineFlags(l: OrderLine): string[] {
  const f: string[] = [];
  if (l.o.status === "Under Process") f.push("underProcess");
  if (l.o.status === "Ready" && l.o.entryStatus !== "Done") f.push(l.allocation === "Done" ? "readyAlloc" : "readyShort");
  if (!l.o.tallyBillNo || l.o.ratePaise == null) f.push("billMissing");
  if (l.o.partyStatus === "Pending") f.push("pendingParty");
  if (l.inDetails) f.push("detailed");
  return f;
}

/* ============================================================== forms */

async function orderForm(ctx: ErpContext, fixed?: { orderNo: number; date: string; godown: string; billing: string; delivery: string; transporter: string }): Promise<FormSpec> {
  const [gds, parties, skus, prices] = await Promise.all([godownOptions(ctx, { lost: false }), loadCustomers(), skuCatalogue(), priceBook()]);
  const active = parties.filter((p) => partyStatus(p) !== "Deactive");
  const names = active.map((p) => p.name);
  const party: Record<string, { a: string; si: string; t: string; g: string }> = {};
  for (const p of active)
    party[p.name] = {
      a: p.area ?? "",
      si: standingInstructions({ instructions: p.p?.standingInstructions ?? null, deliveryType: p.deliveryType, paymentType: p.freightTerm, weightType: p.p?.weightType ?? null }),
      t: p.p?.transporter ?? "",
      g: p.priceTag ?? "",
    };
  const skuList = [...skus.values()].sort((a, b) => a.name.localeCompare(b.name));
  const cpb: Record<string, number> = {};
  const loose: Record<string, boolean> = {};
  const rate: Record<string, number | null> = {};
  const disc: Record<string, number | null> = {};
  const tags = [...new Set(active.map((p) => p.priceTag).filter(Boolean))] as string[];
  for (const s of skuList) {
    cpb[s.name] = s.cpb;
    loose[s.name] = !isBoxed(s);
    for (const t of tags) {
      const pr = prices(t, s);
      if (pr.ratePaise != null) rate[`${t}|${s.name}`] = pr.ratePaise;
      if (pr.discountBp != null) disc[t] = pr.discountBp;
    }
  }
  const seeRate = ctx.powers.has("viewSalesRate");
  const seeAmounts = ctx.powers.has("viewSalesAmounts");
  return {
    screen: "orders",
    id: fixed ? "more" : "new",
    title: fixed ? `Add to order ${fixed.orderNo}` : "New sales order",
    sub: "One line per SKU. Rate and discount default from the billing party's price list.",
    submit: "Save order",
    lineLabel: "SKU",
    init: fixed
      ? { orderFixed: String(fixed.orderNo), date: fixed.date, godown: fixed.godown, billing: fixed.billing, delivery: fixed.delivery, transporter: fixed.transporter }
      : { date: today(), godown: ctx.workingGodown?.name ?? "" },
    data: { party, cpb, loose, ...(seeRate ? { rate } : {}), ...(seeAmounts ? { disc } : {}) },
    header: [
      { k: "orderNo", l: "Order number", t: "derived", calc: "order.no" },
      { k: "date", l: "Date", t: "date", req: true, readOnly: !!fixed },
      { k: "godown", l: "Godown", t: "select", req: true, opts: gds.map((g) => g.name), readOnly: !!fixed },
      { k: "billing", l: "Billing party", t: "select", req: true, opts: names, readOnly: !!fixed },
      { k: "delivery", l: "Delivery party", t: "select", opts: names, hint: "Blank delivers to the billing party.", readOnly: !!fixed },
      { k: "area", l: "Area", t: "derived", calc: "order.area" },
      { k: "si", l: "Standing instructions", t: "derived", calc: "order.si" },
      { k: "transporter", l: "Transporter", t: "text", hint: "Blank uses the delivery party's transporter." },
    ],
    line: [
      { k: "sku", l: "Description of goods", t: "select", req: true, opts: skuList.map((s) => s.name) },
      { k: "qty", l: "Order qty (cans)", t: "num", req: true, min: 1 },
      { k: "boxes", l: "Box quantity", t: "derived", calc: "order.boxes" },
      ...(seeRate ? ([{ k: "rate", l: "Rate (₹)", t: "num", min: 0, hint: "Blank takes the price-list rate." }, { k: "listRate", l: "Price-list rate", t: "derived", calc: "order.listRate" }] as FieldSpec[]) : []),
      ...(seeAmounts ? ([{ k: "discount", l: "Discount %", t: "num", min: 0, max: 100, hint: "Blank takes the price-list discount." }] as FieldSpec[]) : []),
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

async function editForm(ctx: ErpContext, id: string): Promise<FormSpec | null> {
  const l = (await orderLines()).find((x) => x.o.id === id);
  if (!l) return null;
  const names = (await loadCustomers()).filter((p) => partyStatus(p) !== "Deactive").map((p) => p.name);
  const seeRate = ctx.powers.has("viewSalesRate");
  const seeAmounts = ctx.powers.has("viewSalesAmounts");
  const locked = l.inDetails || l.allocations > 0;
  return {
    screen: "orders",
    id: "edit",
    recordId: id,
    title: `Edit order ${l.o.orderNo} · ${l.sku.name}`,
    sub: locked ? "Lots are allocated to this line, so its SKU is fixed." : undefined,
    submit: "Save line",
    init: {
      status: l.o.status,
      delivery: l.delivery.name,
      transporter: l.o.transporter ?? "",
      qty: String(l.o.qtyCans),
      rate: rupeesField(l.o.ratePaise),
      discount: l.o.discountBp == null ? "" : String(l.o.discountBp / 100),
      bill: l.o.tallyBillNo ?? "",
      transport: rupeesField(l.o.transportCostPaise),
      remark: l.o.remark ?? "",
    },
    header: [
      { k: "status", l: "Status", t: "select", req: true, opts: ORDER_STATUSES },
      { k: "delivery", l: "Delivery party", t: "select", req: true, opts: names, readOnly: l.inDetails },
      { k: "transporter", l: "Transporter", t: "text" },
      { k: "qty", l: "Order qty (cans)", t: "num", req: true, min: 1, readOnly: l.inDetails },
      ...(seeRate ? ([{ k: "rate", l: "Rate (₹)", t: "num", min: 0 }] as FieldSpec[]) : []),
      ...(seeAmounts ? ([{ k: "discount", l: "Discount %", t: "num", min: 0, max: 100 }] as FieldSpec[]) : []),
      { k: "bill", l: "Tally bill no.", t: "text" },
      { k: "transport", l: "Transportation cost (₹)", t: "num", min: 0 },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

async function allocateForm(ctx: ErpContext, id: string): Promise<FormSpec | null> {
  const l = (await orderLines()).find((x) => x.o.id === id);
  if (!l) return null;
  const lots = l.boxed
    ? (await packLots()).filter((x) => x.skuId === l.sku.id && x.godownId === l.o.godownId && x.stock > 0).map((x) => ({ code: x.batchNo, stock: x.stock }))
    : (await fgLots()).filter((x) => x.skuId === l.sku.id && x.godownId === l.o.godownId && x.stock > 0).map((x) => ({ code: x.lotCode, stock: x.stock }));
  const target = allocationTarget(l.boxed, l.boxes, l.o.qtyCans);
  const required = Math.max(0, target - l.allocated);
  const avail: Record<string, number> = {};
  lots.forEach((x) => (avail[x.code] = x.stock));
  const unit = l.boxed ? "Box" : "Can";
  return {
    screen: "orders",
    id: "allocate",
    recordId: id,
    title: `Allocate a lot · order ${l.o.orderNo}`,
    sub: `${l.sku.name} at ${l.godown}. ${l.boxed ? "Boxes from packing stock." : "Cans from FG stock."} Scan a lot label into the lot field, or pick one.`,
    submit: "Allocate",
    init: { required: String(required), qty: String(required) },
    data: { avail, required, sku: l.sku.name, from: l.boxed ? "FG Packing Inventory" : "Finish Goods Inventory", unit: l.boxed ? "boxes" : "cans" },
    header: [
      { k: "sku", l: "Description of goods", t: "derived", calc: "alloc.sku" },
      { k: "requiredShown", l: `Required ${unit.toLowerCase()} quantity`, t: "derived", calc: "alloc.required" },
      { k: "from", l: "Lot code from", t: "derived", calc: "alloc.from" },
      { k: "lot", l: "Lot code", t: "scan", req: true, opts: lots.map((x) => x.code), hint: lots.length ? "Scan or type; the list shows lots with stock here." : "No lot of this SKU has stock at this godown." },
      { k: "avail", l: `Available ${unit.toLowerCase()} quantity`, t: "derived", calc: "alloc.avail" },
      { k: "qty", l: "Quantity", t: "num", req: true, min: 1 },
    ],
  };
}

/* ============================================================ list rows */

type Scope = "orders" | "pendingOrders" | "readyOrders" | "labels";

function inScope(scope: Scope, l: OrderLine, detailedOrders: Set<number>): boolean {
  if (scope === "orders") return true;
  if (scope === "pendingOrders") return l.o.status !== "Cancel" && l.sku.name !== "Empty Drum" && !detailedOrders.has(l.o.orderNo);
  return (l.o.status === "Ready" || l.o.status === "Under Process") && l.o.entryStatus !== "Done";
}

function orderList(scope: Scope): ScreenModule {
  return {
    key: scope,
    async load(ctx) {
      const lines = await orderLines();
      const detailedOrders = new Set(lines.filter((l) => l.inDetails).map((l) => l.o.orderNo));
      const shown = lines.filter((l) => inScope(scope, l, detailedOrders));
      const labels = scope === "labels";
      const all: Col[] = labels
        ? [
            { k: "orderId", l: "Order id", t: "mono" },
            { k: "orderNo", l: "Order no", t: "mono" },
            { k: "date", l: "Date", t: "d" },
            { k: "billing", l: "Billing party", t: "t" },
            { k: "delivery", l: "Delivery party", t: "b" },
            { k: "sku", l: "Description of goods", t: "t", w: 240 },
            { k: "qty", l: "Order qty", t: "n" },
            { k: "type", l: "Type", t: "s" },
            { k: "remark", l: "Remark", t: "t" },
            { k: "transporter", l: "Transporter", t: "t" },
            { k: "area", l: "Area", t: "t" },
            { k: "labels", l: "No of label", t: "n" },
            { k: "status", l: "Status", t: "s" },
            { k: "weight", l: "Weight", t: "n" },
          ]
        : [
            { k: "orderNo", l: "Order no", t: "mono" },
            { k: "date", l: "Date", t: "d" },
            { k: "status", l: "Status", t: "s" },
            { k: "billing", l: "Billing party", t: "b" },
            { k: "delivery", l: "Delivery party", t: "t" },
            { k: "sku", l: "Description of goods", t: "t", w: 240 },
            { k: "qty", l: "Order qty", t: "n" },
            { k: "boxes", l: "Boxes", t: "n" },
            { k: "rate", l: "Rate", t: "m", pw: "viewSalesRate" },
            { k: "discount", l: "Discount %", t: "n", pw: "viewSalesAmounts" },
            { k: "alloc", l: "Can quantity verification", t: "s" },
            { k: "entry", l: "Entry", t: "s" },
            { k: "bill", l: "Tally bill no", t: "mono" },
            { k: "transporter", l: "Transporter", t: "t" },
            { k: "labels", l: "Labels", t: "n" },
            { k: "godown", l: "Godown", t: "t" },
            { k: "f", l: "Flags", t: "f" },
          ];
      const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
      const approver = ctx.powers.has("approveParty");
      const bulk: BulkSpec[] = labels
        ? []
        : [
            { id: "ready", l: "Ready" },
            { id: "underProcess", l: "Under Process" },
            { id: "done", l: "Done" },
            { id: "notDone", l: "Not Done" },
            ...(approver ? [{ id: "approve", l: "Approved By Admin" }] : []),
            { id: "renumber", l: "Generate New Order Number", confirm: "Give every selected line one new order number, as one order?" },
            { id: "toDetails", l: "Add To Order Details" },
          ];
      const byNo = new Map<number, string[]>();
      shown.forEach((l) => byNo.set(l.o.orderNo, [...(byNo.get(l.o.orderNo) ?? []), l.o.id]));
      return {
        spec: {
          screen: scope,
          cols,
          hidden,
          groups: labels ? ["transporter"] : scope === "pendingOrders" ? ["date", "orderNo"] : ["orderNo"],
          groupSel: !labels,
          agg: { k: "labels", l: "labels" },
          godownKey: "godown",
          readOnly: labels,
          download: labels,
          sortDefault: labels ? ["sku", 1] : undefined,
          bulk: bulk.length ? bulk : undefined,
          newForm: scope === "orders" ? await orderForm(ctx) : undefined,
          newLabel: "New order",
          noDataLine:
            scope === "orders"
              ? "No sales orders yet."
              : scope === "pendingOrders"
                ? "Nothing pending. Every open line has reached order details."
                : "Nothing under process or ready.",
        },
        rows: shown.map((l): ListRow => {
          const blockers = detailsBlockers(l);
          const actions: ActionSpec[] = labels
            ? []
            : [
                ...(l.o.status !== "Ready" ? [{ id: "ready", l: "Ready", primary: true } as ActionSpec] : [{ id: "underProcess", l: "Under Process" } as ActionSpec]),
                {
                  id: "allocate",
                  l: "Allocate a lot",
                  primary: l.o.status === "Ready" && l.allocation === "Add More Quantity",
                  loadsForm: true,
                  why: l.o.status !== "Ready" ? "Lots are allocated once the line is Ready" : l.allocation !== "Add More Quantity" ? (l.allocation === "Done" ? "Fully allocated" : "Over-allocated: remove a batch code first") : !l.boxesValid ? "The box quantity is not whole" : "",
                },
                {
                  id: "done",
                  l: "Done",
                  why: l.o.entryStatus === "Done" ? "Already Done" : l.o.status !== "Ready" ? "Set it Ready first" : l.allocation !== "Done" ? `Allocation: ${l.allocation}` : "",
                },
                ...(l.o.entryStatus === "Done" ? [{ id: "notDone", l: "Not Done" } as ActionSpec] : []),
                ...(approver && l.o.partyStatus !== "Approved By Admin" ? [{ id: "approve", l: "Approved By Admin" } as ActionSpec] : []),
                { id: "toDetails", l: "Add To Order Details", primary: !blockers.length, why: blockers.length ? `Needs ${blockers.join(", ")}` : "" },
                { id: "edit", l: "Edit", loadsForm: true },
                { id: "more", l: "ADD More", loadsForm: true },
                { id: "renumber", l: "Generate New Order Number", confirm: `Move this line to a new order number?` },
                { id: "select", l: "Select Order Number", href: `?f=${encodeURIComponent((byNo.get(l.o.orderNo) ?? []).join(","))}&fl=${encodeURIComponent(`Order ${l.o.orderNo}`)}` },
                { id: "customer", l: "View customer", href: `/erp/customers?open=${l.billing.id}` },
                {
                  id: "delete",
                  l: "Delete",
                  why: l.inDetails ? "In order details" : l.allocations ? "Release its batch codes first" : "",
                  confirm: `Delete this line of order ${l.o.orderNo}?`,
                },
              ];
          return {
            id: l.o.id,
            v: withoutHidden(
              {
                orderId: l.o.id,
                orderNo: String(l.o.orderNo),
                date: l.o.orderDate,
                status: l.o.status,
                billing: l.billing.name,
                delivery: l.delivery.name,
                sku: l.sku.name,
                qty: l.o.qtyCans,
                boxes: l.boxed ? l.boxes : null,
                rate: l.o.ratePaise,
                discount: l.o.discountBp == null ? null : l.o.discountBp / 100,
                alloc: l.allocation,
                entry: l.o.entryStatus,
                bill: l.o.tallyBillNo,
                transporter: l.o.transporter ?? l.delivery.p?.transporter ?? "—",
                labels: l.labels,
                type: l.type,
                remark: l.o.remark,
                area: l.delivery.area,
                weight: l.sku.weightKg,
                godown: l.godown,
              },
              hiddenKeys,
            ),
            flags: lineFlags(l),
            title: l.delivery.name,
            header: l.si.replace(/( - )+$/, "") || `${l.sku.name} · ${nf(l.o.qtyCans)} cans`,
            fields: [
              { l: "Order id", v: l.o.id },
              { l: "Standing instructions", v: l.si || "—", der: true },
              { l: "Area", v: l.delivery.area ?? "—", der: true },
              { l: "Type", v: l.type, der: true },
              { l: "Allocated", v: `${nf(l.allocated)} of ${nf(allocationTarget(l.boxed, l.boxes, l.o.qtyCans))} ${l.boxed ? "boxes" : "cans"} · ${l.allocations} batch code${l.allocations === 1 ? "" : "s"}`, der: true },
              { l: "Weight", v: l.sku.weightKg == null ? "—" : `${nf(l.sku.weightKg)} kg`, der: true },
              { l: "Tag price list", v: l.billing.priceTag ?? "—", der: true },
              ...(ctx.powers.has("viewSalesRate") ? [{ l: "Rate 2 (live price list)", v: l.liveRatePaise == null ? "—" : inr(l.liveRatePaise), der: true }] : []),
              { l: "Transportation cost", v: inr(l.o.transportCostPaise) },
              { l: "Party status", v: l.o.partyStatus ?? "—" },
              { l: "Remark", v: l.o.remark || "—" },
            ],
            actions,
            by: stampLine(l.by, l.o.createdAt),
          };
        }),
      };
    },
    ...(scope === "labels" ? {} : lineHandlers(scope)),
  };
}

/* ============================================================ handlers */

async function lines(ids: string[]): Promise<OrderLine[]> {
  const set = new Set(ids);
  return (await orderLines()).filter((l) => set.has(l.o.id));
}

async function setMany(ctx: ErpContext, ids: string[], values: Partial<typeof erpOrders.$inferInsert>, action: string, msg: (n: number) => string): Promise<Result<unknown>> {
  if (!ids.length) return err("Nothing selected.");
  await db.update(erpOrders).set({ ...values, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpOrders.id, ids));
  await erpAudit(ctx, action, "erp_order", ids.join(","), null, values);
  return okVoid(msg(ids.length));
}

const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

async function doReady(ctx: ErpContext, ids: string[]) {
  return setMany(ctx, ids, { status: "Ready" }, "erp.order.ready", (n) => `${plural(n)} Ready`);
}
async function doUnder(ctx: ErpContext, ids: string[]) {
  const ls = await lines(ids);
  const ok = ls.filter((l) => l.o.status === "Ready").map((l) => l.o.id);
  if (!ok.length) return err("Only a Ready line goes back to Under Process.", "rule_violation");
  return setMany(ctx, ok, { status: "Under Process" }, "erp.order.underProcess", (n) => `${plural(n)} Under Process`);
}
async function doDone(ctx: ErpContext, ids: string[]) {
  const ls = await lines(ids);
  const ok = ls.filter((l) => l.o.entryStatus !== "Done" && l.o.status === "Ready" && l.allocation === "Done").map((l) => l.o.id);
  if (!ok.length) return err("A line is Done once it is Ready and its lots are allocated in full.", "rule_violation");
  const res = await setMany(ctx, ok, { entryStatus: "Done" }, "erp.order.done", (n) => `${plural(n)} Done`);
  return res.ok && ok.length < ids.length ? okVoid(`${plural(ok.length)} Done · ${ids.length - ok.length} not ready or not fully allocated`) : res;
}
async function doNotDone(ctx: ErpContext, ids: string[]) {
  const ls = await lines(ids);
  const blocked = ls.filter((l) => l.inDetails);
  if (blocked.length === ls.length) return err("These lines are in order details.", "rule_violation");
  return setMany(ctx, ls.filter((l) => !l.inDetails).map((l) => l.o.id), { entryStatus: "Not Done" }, "erp.order.notDone", (n) => `${plural(n)} Not Done`);
}
async function doApprove(ctx: ErpContext, ids: string[]) {
  if (!ctx.powers.has("approveParty")) return err("Only an admin or the office approves a pending party's order.", "not_permitted");
  return setMany(ctx, ids, { partyStatus: "Approved By Admin" }, "erp.order.approveParty", (n) => `${plural(n)} approved`);
}
/** A-17: the whole selection becomes ONE new order. */
async function doRenumber(ctx: ErpContext, ids: string[]) {
  const ls = await lines(ids);
  if (ls.some((l) => l.inDetails)) return err("A line already in order details keeps its order number.", "rule_violation");
  let no = 0;
  await db.transaction(async (tx) => {
    no = await nextNumber(tx, "order");
    await tx.update(erpOrders).set({ orderNo: no, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpOrders.id, ids));
  });
  await erpAudit(ctx, "erp.order.renumber", "erp_order", ids.join(","), null, { orderNo: no });
  return okVoid(`${plural(ids.length)} moved to order ${no}`);
}
async function doToDetails(ctx: ErpContext, ids: string[]) {
  const ls = await lines(ids);
  const ok = ls.filter((l) => !detailsBlockers(l).length);
  if (!ok.length) {
    const why = ls.length === 1 ? detailsBlockers(ls[0]).join(", ") : "each line needs to be Ready and Done, with a Tally bill no., a rate and its lots allocated";
    return err(`Not yet: ${why}.`, "rule_violation");
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(erpOrderDetails)
      .values(ok.map((l) => ({ orderId: l.o.id, createdById: ctx.user.id, updatedById: ctx.user.id })))
      .onConflictDoNothing();
    /* §18: every detail line gets its follow-up record, once (PRD Q5 — on
       entering order details, until the client says otherwise). */
    await tx
      .insert(erpFollowups)
      .values(ok.map((l) => ({ orderId: l.o.id, updatedById: ctx.user.id })))
      .onConflictDoNothing();
  });
  await erpAudit(ctx, "erp.order.toDetails", "erp_order", ok.map((l) => l.o.id).join(","));
  return okVoid(ok.length < ls.length ? `${plural(ok.length)} added to order details · ${ls.length - ok.length} not ready yet` : `${plural(ok.length)} added to order details`);
}

function lineHandlers(scope: Scope): Pick<ScreenModule, "actions" | "bulk" | "forms" | "formLoaders"> {
  return {
    bulk: {
      ready: (ctx, ids) => doReady(ctx, ids),
      underProcess: (ctx, ids) => doUnder(ctx, ids),
      done: (ctx, ids) => doDone(ctx, ids),
      notDone: (ctx, ids) => doNotDone(ctx, ids),
      approve: (ctx, ids) => doApprove(ctx, ids),
      renumber: (ctx, ids) => doRenumber(ctx, ids),
      toDetails: (ctx, ids) => doToDetails(ctx, ids),
    },
    actions: {
      ready: (ctx, id) => doReady(ctx, [id]),
      underProcess: (ctx, id) => doUnder(ctx, [id]),
      done: (ctx, id) => doDone(ctx, [id]),
      notDone: (ctx, id) => doNotDone(ctx, [id]),
      approve: (ctx, id) => doApprove(ctx, [id]),
      renumber: (ctx, id) => doRenumber(ctx, [id]),
      toDetails: (ctx, id) => doToDetails(ctx, [id]),
      async delete(ctx, id) {
        const [l] = await lines([id]);
        if (!l) return err("That line no longer exists.", "not_found");
        if (l.inDetails) return err("A line in order details is not deleted.", "rule_violation");
        if (l.allocations) return err("Release its batch codes first; they hold stock.", "rule_violation");
        await db.delete(erpOrders).where(eq(erpOrders.id, id));
        await erpAudit(ctx, "erp.order.delete", "erp_order", id, l.o, null);
        return okVoid("Line deleted");
      },
    },
    formLoaders: {
      edit: editForm,
      allocate: allocateForm,
      async more(ctx, id) {
        const [l] = await lines([id]);
        if (!l) return null;
        return orderForm(ctx, { orderNo: l.o.orderNo, date: l.o.orderDate, godown: l.godown, billing: l.billing.name, delivery: l.delivery.name, transporter: l.o.transporter ?? "" });
      },
    },
    forms: {
      ...(scope === "orders" ? { new: (ctx, h, ls) => saveOrder(ctx, h, ls) } : {}),
      more: (ctx, h, ls) => saveOrder(ctx, h, ls),
      edit: (ctx, h, _l, id) => saveEdit(ctx, h, id),
      allocate: (ctx, h, _l, id) => saveAllocation(ctx, h, id),
    },
  };
}

async function partyByName(name: string | null): Promise<CustomerRow | null> {
  if (!name) return null;
  const [p] = await loadCustomers(eq(customers.name, name));
  return p ?? null;
}

async function saveOrder(ctx: ErpContext, h: Record<string, string>, ls: Record<string, string>[]): Promise<Result<unknown>> {
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const billing = await partyByName(text(h.billing));
  if (!billing) return fieldErr("billing", "Billing party is required");
  if (partyStatus(billing) === "Deactive") return fieldErr("billing", "This party is deactivated");
  const delivery = (await partyByName(text(h.delivery))) ?? billing;
  if (!ls.length) return err("Add at least one SKU.");
  const [skus, prices] = await Promise.all([skuCatalogue(), priceBook()]);
  const byName = new Map([...skus.values()].map((s) => [s.name, s]));
  const seeRate = ctx.powers.has("viewSalesRate");
  const seeAmounts = ctx.powers.has("viewSalesAmounts");
  const parsed: { sku: Sku; qty: number; rate: number | null; discount: number | null; remark: string | null }[] = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const sku = byName.get(l.sku ?? "");
    if (!sku) return fieldErr(`l${i}.sku`, "Pick an SKU");
    const qty = int(l.qty);
    if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, "Minus Quantity Not Allowed");
    if (!boxQuantity(qty, sku.cpb, !isBoxed(sku)).valid) return fieldErr(`l${i}.qty`, "INVALID");
    const list = prices(billing.priceTag, sku);
    /* Somebody who cannot see the rate cannot set it either: the list decides. */
    const typedRate = seeRate ? paise(l.rate) : null;
    const typedDisc = seeAmounts ? num(l.discount) : null;
    if (typedDisc != null && (typedDisc < 0 || typedDisc > 100)) return fieldErr(`l${i}.discount`, "Discount must be between 0 and 100");
    parsed.push({
      sku,
      qty,
      rate: typedRate ?? list.ratePaise,
      discount: typedDisc != null ? Math.round(typedDisc * 100) : list.discountBp,
      remark: text(l.remark),
    });
  }
  const fixed = int(h.orderFixed);
  let no = 0;
  await db.transaction(async (tx) => {
    no = fixed ?? (await nextNumber(tx, "order"));
    for (const p of parsed)
      await tx.insert(erpOrders).values({
        id: `ODID-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        orderNo: no,
        orderDate: text(h.date) ?? today(),
        godownId,
        billingCustomerId: billing.id,
        deliveryCustomerId: delivery.id,
        transporter: text(h.transporter) ?? delivery.p?.transporter ?? null,
        skuId: p.sku.id,
        qtyCans: p.qty,
        ratePaise: p.rate,
        discountBp: p.discount,
        remark: p.remark,
        partyStatus: partyStatus(billing) === "Pending" ? "Pending" : null,
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
  });
  await erpAudit(ctx, "erp.order.create", "erp_order", String(no), null, { lines: parsed.length, billing: billing.name });
  const noRate = parsed.filter((p) => p.rate == null).length;
  return okVoid(`Order ${no} saved · ${plural(parsed.length)}${noRate ? ` · ${noRate} without a rate: none on ${billing.priceTag ? `price list "${billing.priceTag}"` : "the party, which has no price list"}` : ""}`);
}

async function saveEdit(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  if (!id) return err("No line named.", "not_found");
  const [l] = await lines([id]);
  if (!l) return err("That line no longer exists.", "not_found");
  const status = text(h.status);
  if (!status || !ORDER_STATUSES.includes(status)) return fieldErr("status", "Status is required");
  const qty = int(h.qty);
  if (qty == null || qty <= 0) return fieldErr("qty", "Minus Quantity Not Allowed");
  if (l.inDetails && qty !== l.o.qtyCans) return fieldErr("qty", "This line is in order details; its quantity is fixed");
  if (!boxQuantity(qty, l.sku.cpb, !l.boxed).valid) return fieldErr("qty", "INVALID");
  const delivery = (await partyByName(text(h.delivery))) ?? l.delivery;
  const values: Partial<typeof erpOrders.$inferInsert> = {
    status,
    qtyCans: qty,
    deliveryCustomerId: l.inDetails ? l.o.deliveryCustomerId : delivery.id,
    transporter: text(h.transporter),
    tallyBillNo: text(h.bill),
    transportCostPaise: paise(h.transport) ?? 0,
    remark: text(h.remark),
  };
  if (ctx.powers.has("viewSalesRate")) values.ratePaise = paise(h.rate);
  if (ctx.powers.has("viewSalesAmounts")) {
    const d = num(h.discount);
    if (d != null && (d < 0 || d > 100)) return fieldErr("discount", "Discount must be between 0 and 100");
    values.discountBp = d == null ? null : Math.round(d * 100);
  }
  /* A Done line whose quantity moves is no longer allocated in full. */
  if (qty !== l.o.qtyCans && l.o.entryStatus === "Done") values.entryStatus = "Not Done";
  await db.update(erpOrders).set({ ...values, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpOrders.id, id));
  await erpAudit(ctx, "erp.order.edit", "erp_order", id, l.o, values);
  return okVoid("Line saved");
}

async function saveAllocation(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  if (!id) return err("No line named.", "not_found");
  const lot = text(h.lot);
  if (!lot) return fieldErr("lot", "Lot code is required");
  const qty = num(h.qty);
  if (qty == null || qty <= 0) return fieldErr("qty", "Invalid Quantity Or Wait For Synchronization");
  const [l] = await lines([id]);
  if (!l) return err("That line no longer exists.", "not_found");
  if (l.o.status !== "Ready") return err("Lots are allocated once the line is Ready.", "rule_violation");
  if (l.boxed && !l.boxesValid) return err("The box quantity is not whole; fix the order quantity first.", "rule_violation");
  return inTx(async (tx) => {
    await lockLot(tx, l.boxed ? "pack" : "fg", lot, l.o.godownId);
    const src = l.boxed
      ? (await packLots(tx)).find((x) => x.batchNo === lot && x.godownId === l.o.godownId && x.skuId === l.sku.id)
      : (await fgLots(tx)).find((x) => x.lotCode === lot && x.godownId === l.o.godownId && x.skuId === l.sku.id);
    if (!src) return refuse(fieldErr("lot", `No ${l.boxed ? "packing batch" : "FG lot"} ${lot} of this SKU has stock at ${l.godown}`));
    const [{ allocated }] = (await tx.execute(sql`select coalesce(sum(quantity), 0)::float8 as allocated from erp_batch_codes where order_id = ${id}`)) as unknown as { allocated: number }[];
    const required = allocationTarget(l.boxed, l.boxes, l.o.qtyCans) - Number(allocated);
    if (qty > required + 1e-9 || qty > src.stock + 1e-9) return refuse(fieldErr("qty", "Invalid Quantity Or Wait For Synchronization"));
    await tx.insert(erpBatchCodes).values({
      id: erpId("bc"),
      orderId: id,
      lotFrom: l.boxed ? "pack" : "fg",
      lotCode: lot,
      finishedGoodId: l.boxed ? null : "finishedGoodId" in src ? src.finishedGoodId : null,
      godownId: l.o.godownId,
      quantity: qty,
      createdById: ctx.user.id,
    });
    await erpAudit(ctx, "erp.batchCode.create", "erp_batch_code", id, null, { lot, qty });
    const left = required - qty;
    return okVoid(left > 0 ? `${nf(qty)} from ${lot} · ${nf(left)} still to allocate` : `${nf(qty)} from ${lot} · allocation Done`);
  });
}

/* ========================================================= batch codes */

const batchCodes: ScreenModule = {
  key: "batchCodes",
  async load(ctx) {
    const [rows, fg, pack] = await Promise.all([
      db
        .select({ b: erpBatchCodes, o: erpOrders, sku: products.name, godown: erpGodowns.name, by: users.name, verified: erpOrderDetails.verification })
        .from(erpBatchCodes)
        .innerJoin(erpOrders, eq(erpOrders.id, erpBatchCodes.orderId))
        .innerJoin(products, eq(products.id, erpOrders.skuId))
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpBatchCodes.godownId))
        .leftJoin(erpOrderDetails, eq(erpOrderDetails.orderId, erpOrders.id))
        .leftJoin(users, eq(users.id, erpBatchCodes.createdById))
        .orderBy(desc(erpBatchCodes.createdAt)),
      fgLots(),
      packLots(),
    ]);
    const fgRate = new Map(fg.map((l) => [`${l.finishedGoodId}|${l.lotCode}`, l.ratePaise]));
    const packRate = new Map(pack.map((l) => [l.batchNo, l.perCanPaise]));
    const all: Col[] = [
      { k: "orderNo", l: "Order no", t: "mono" },
      { k: "orderId", l: "Order id", t: "mono" },
      { k: "sku", l: "Description of goods", t: "b", w: 240 },
      { k: "from", l: "Lot code from", t: "s" },
      { k: "lot", l: "Lot code", t: "mono" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "costing", l: "Costing", t: "m", pw: "viewCost" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "date", l: "Allocated", t: "d" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: { screen: "batchCodes", cols, hidden, groups: ["godown"], godownKey: "godown", noDataLine: "No lots allocated yet. Allocate from a Ready order line." },
      rows: rows.map((r): ListRow => {
        const dispatched = r.verified === "Verified";
        return {
          id: r.b.id,
          v: withoutHidden(
            {
              orderNo: String(r.o.orderNo),
              orderId: r.o.id,
              sku: r.sku,
              from: r.b.lotFrom === "pack" ? "FG Packing Inventory" : "Finish Goods Inventory",
              lot: r.b.lotCode,
              qty: r.b.quantity,
              costing: r.b.lotFrom === "pack" ? (packRate.get(r.b.lotCode) ?? null) : (fgRate.get(`${r.b.finishedGoodId}|${r.b.lotCode}`) ?? null),
              godown: r.godown,
              date: calendarDate(r.b.createdAt),
            },
            hiddenKeys,
          ),
          flags: [],
          title: `${r.b.lotCode} → order ${r.o.orderNo}`,
          header: `${nf(r.b.quantity)} ${r.b.lotFrom === "pack" ? "boxes" : "cans"} of ${r.sku}`,
          actions: [
            {
              id: "qty",
              l: "Change quantity",
              why: dispatched ? "The order has been dispatch-verified" : "",
              prompt: { title: "Change the allocated quantity", sub: `${r.b.lotCode} · order ${r.o.orderNo}`, submit: "Save", fields: [{ k: "qty", l: "Quantity", t: "num", req: true, min: 1 }], init: { qty: String(r.b.quantity) } },
            },
            { id: "release", l: "Release", why: dispatched ? "The order has been dispatch-verified" : "", confirm: `Release ${nf(r.b.quantity)} from ${r.b.lotCode} back to stock?` },
          ],
          by: stampLine(r.by, r.b.createdAt),
        };
      }),
    };
  },
  actions: {
    async qty(ctx, id, values) {
      const qty = num(values.qty);
      if (qty == null || qty <= 0) return fieldErr("qty", "Invalid Quantity Or Wait For Synchronization");
      const [b] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.id, id));
      if (!b) return err("That allocation no longer exists.", "not_found");
      const [l] = await lines([b.orderId]);
      if (!l) return err("Its order line no longer exists.", "not_found");
      const [d] = await db.select({ v: erpOrderDetails.verification }).from(erpOrderDetails).where(eq(erpOrderDetails.orderId, b.orderId));
      if (d?.v === "Verified") return err("The order has been dispatch-verified.", "rule_violation");
      return inTx(async (tx) => {
        await lockLot(tx, b.lotFrom, b.lotCode, b.godownId);
        const stock = b.lotFrom === "pack"
          ? ((await packLots(tx)).find((x) => x.batchNo === b.lotCode && x.godownId === b.godownId)?.stock ?? 0)
          : ((await fgLots(tx)).find((x) => x.lotCode === b.lotCode && x.godownId === b.godownId && x.finishedGoodId === b.finishedGoodId)?.stock ?? 0);
        /* A-18: this row's own quantity is not counted against it. */
        const [{ others }] = (await tx.execute(sql`select coalesce(sum(quantity), 0)::float8 as others from erp_batch_codes where order_id = ${b.orderId} and id <> ${id}`)) as unknown as { others: number }[];
        const required = allocationTarget(l.boxed, l.boxes, l.o.qtyCans) - Number(others);
        if (qty > required + 1e-9 || qty > stock + b.quantity + 1e-9) return refuse(fieldErr("qty", "Invalid Quantity Or Wait For Synchronization"));
        await tx.update(erpBatchCodes).set({ quantity: qty }).where(eq(erpBatchCodes.id, id));
        await erpAudit(ctx, "erp.batchCode.qty", "erp_batch_code", id, { quantity: b.quantity }, { quantity: qty });
        return okVoid("Allocation saved");
      });
    },
    async release(ctx, id) {
      const [b] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.id, id));
      if (!b) return err("That allocation no longer exists.", "not_found");
      const [d] = await db.select({ v: erpOrderDetails.verification }).from(erpOrderDetails).where(eq(erpOrderDetails.orderId, b.orderId));
      if (d?.v === "Verified") return err("The order has been dispatch-verified.", "rule_violation");
      await db.transaction(async (tx) => {
        await tx.delete(erpBatchCodes).where(eq(erpBatchCodes.id, id));
        /* A Done line no longer allocated in full is not Done. */
        await tx.update(erpOrders).set({ entryStatus: "Not Done", updatedAt: new Date(), updatedById: ctx.user.id }).where(and(eq(erpOrders.id, b.orderId), eq(erpOrders.entryStatus, "Done")));
      });
      await erpAudit(ctx, "erp.batchCode.release", "erp_batch_code", id, b, null);
      return okVoid(`${nf(b.quantity)} back in ${b.lotCode}`);
    },
  },
};

/* ======================================================= order details */

type DetailRow = {
  l: OrderLine;
  d: typeof erpOrderDetails.$inferSelect;
  amount: number | null;
  discounted: number | null;
  final: number | null;
  litres: number;
  company: string;
  costing: number | null;
  margin: number | null;
  monthId: string | null;
};

export async function detailRows(): Promise<{ rows: DetailRow[]; billTotal: Map<string, number>; monthly: Map<string, number> }> {
  const [ls, details, costs] = await Promise.all([orderLines(), db.select().from(erpOrderDetails), allocationCosts()]);
  const byId = new Map(ls.map((l) => [l.o.id, l]));
  const rows: DetailRow[] = [];
  for (const d of details) {
    const l = byId.get(d.orderId);
    if (!l) continue;
    const bill = billFigures({ type: l.type, qtyCans: l.o.qtyCans, litresPerCan: l.sku.litresPerCan, ratePaise: l.o.ratePaise, discountBp: l.o.discountBp, transportCostPaise: l.o.transportCostPaise, gstBp: d.gstBp });
    const costing = lotCosting({ type: l.type, qtyCans: l.o.qtyCans, litres: bill.litres, costs: costs.get(l.o.id) ?? [], extraPaise: d.extraExpensesPaise });
    rows.push({
      l,
      d,
      amount: bill.amountPaise,
      discounted: bill.discountedPaise,
      final: bill.finalPaise,
      litres: bill.litres,
      company: bill.company,
      costing,
      margin: margin({ amountPaise: bill.amountPaise, discountedPaise: bill.discountedPaise, costingPaise: costing, creditNotePaise: d.creditNotePaise }),
      monthId: monthId(d.dispatchDate),
    });
  }
  const billTotal = new Map<string, number>();
  const monthly = new Map<string, number>();
  for (const r of rows) {
    const bk = `${r.l.o.orderNo}|${r.l.o.billingCustomerId}`;
    billTotal.set(bk, (billTotal.get(bk) ?? 0) + (r.final ?? 0));
    if (r.monthId) {
      const mk = `${r.monthId}|${r.l.o.billingCustomerId}`;
      monthly.set(mk, (monthly.get(mk) ?? 0) + (r.amount ?? 0));
    }
  }
  return { rows, billTotal, monthly };
}

/** Each order line's allocated lots' costing, per can (or per litre on a drum lot). */
async function allocationCosts(): Promise<Map<string, (number | null)[]>> {
  const [codes, fg, pack] = await Promise.all([db.select().from(erpBatchCodes), fgLots(), packLots()]);
  const fgRate = new Map(fg.map((l) => [`${l.finishedGoodId}|${l.lotCode}`, l.ratePaise]));
  const packRate = new Map(pack.map((l) => [l.batchNo, l.perCanPaise]));
  const out = new Map<string, (number | null)[]>();
  for (const b of codes) {
    const c = b.lotFrom === "pack" ? (packRate.get(b.lotCode) ?? null) : (fgRate.get(`${b.finishedGoodId}|${b.lotCode}`) ?? null);
    out.set(b.orderId, [...(out.get(b.orderId) ?? []), c]);
  }
  return out;
}

const orderDetails: ScreenModule = {
  key: "orderDetails",
  async load(ctx) {
    const { rows, billTotal, monthly } = await detailRows();
    const byNo = new Map<number, string[]>();
    rows.forEach((r) => byNo.set(r.l.o.orderNo, [...(byNo.get(r.l.o.orderNo) ?? []), r.l.o.id]));
    const all: Col[] = [
      { k: "follow", l: "Transport follow-up", t: "t" },
      { k: "date", l: "Order date", t: "d" },
      { k: "orderNo", l: "Order no", t: "mono" },
      { k: "billing", l: "Billing party", t: "b" },
      { k: "sku", l: "Description of goods", t: "t", w: 240 },
      { k: "rate", l: "Rate", t: "m", pw: "viewSalesRate" },
      { k: "billTotal", l: "Bill total", t: "m", pw: "viewSalesAmounts" },
      { k: "discount", l: "Discount %", t: "n", pw: "viewSalesAmounts" },
      { k: "dispatchDate", l: "Dispatch date", t: "d" },
      { k: "verification", l: "Verification", t: "s" },
      { k: "qty", l: "Qty", t: "n" },
      { k: "monthly", l: "Monthly sale", t: "m", pw: "viewSalesAmounts" },
      { k: "amount", l: "Amount", t: "m", pw: "viewSalesAmounts" },
      { k: "si", l: "Standing instructions", t: "t" },
      { k: "discounted", l: "Discounted amount", t: "m", pw: "viewSalesAmounts" },
      { k: "orderId", l: "Order id", t: "mono" },
      { k: "area", l: "Area", t: "t" },
      { k: "transporter", l: "Transport name", t: "t" },
      { k: "transport", l: "Transport cost", t: "m" },
      { k: "extra", l: "Extra expenses", t: "m" },
      { k: "bill", l: "Tally bill no", t: "mono" },
      { k: "payment", l: "Payment type", t: "t", pw: "viewCost" },
      { k: "margin", l: "Margin", t: "m", pw: "viewCost" },
      { k: "monthId", l: "Month", t: "t" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "f", l: "Flags", t: "f" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    const amounts = ctx.powers.has("viewSalesAmounts");
    const cost = ctx.powers.has("viewCost");
    return {
      spec: {
        screen: "orderDetails",
        cols,
        hidden,
        groups: ["date", "orderNo"],
        agg: amounts ? { k: "billTotal", l: "average bill", t: "avg" } : undefined,
        godownKey: "godown",
        bulk: [
          { id: "verify", l: "Do Verified", prompt: { title: "Dispatch date", sub: "Marks every selected line Verified and Dispatched.", submit: "Verify", fields: [{ k: "date", l: "Dispatch date", t: "date", req: true }], init: { date: today() } } },
          { id: "extra", l: "Extra Expenses", prompt: { title: "Enter Extra Expenses", submit: "Save", fields: [{ k: "amount", l: "Extra expenses (₹)", t: "num", req: true, min: 0 }] } },
        ],
        noDataLine: "Nothing in order details yet. A Ready, Done, fully allocated line with a bill no. and a rate is added from the order lists.",
      },
      rows: rows
        .sort((a, b) => (a.l.o.orderDate < b.l.o.orderDate ? 1 : a.l.o.orderDate > b.l.o.orderDate ? -1 : b.d.createdAt.getTime() - a.d.createdAt.getTime()))
        .map((r): ListRow => {
          const l = r.l;
          const d = r.d;
          const monthSale = r.monthId ? (monthly.get(`${r.monthId}|${l.o.billingCustomerId}`) ?? 0) : 0;
          const target = l.delivery.p?.monthlyTargetPaise ?? null;
          const flags: string[] = [];
          if (!d.verification || d.verification === "Pending") flags.push("notVerified");
          if (r.monthId && targetReached(monthSale, target)) flags.push("targetReached");
          const verifiable = (!d.verification || d.verification === "Pending") && l.allocations > 0 && l.allocation === "Done";
          const actions: ActionSpec[] = [
            {
              id: "verify",
              l: d.verification === "Verified" ? "Verified" : "Do Verified",
              primary: verifiable,
              why: d.verification === "Verified" ? "Already verified" : !l.allocations ? "No lot is allocated to this line" : l.allocation !== "Done" ? `Allocation: ${l.allocation}` : "",
              prompt: { title: "Dispatch date", sub: `Order ${l.o.orderNo} · ${l.sku.name}`, submit: "Verify", fields: [{ k: "date", l: "Dispatch date", t: "date", req: true }], init: { date: today() } },
            },
            ...(ctx.administrator && d.verification !== "Not Verify" ? [{ id: "notVerify", l: "Not Verify", confirm: "Mark this line Not Verify?" } as ActionSpec] : []),
            {
              id: "extra",
              l: "Extra Expenses",
              why: d.extraExpensesPaise != null ? "Already entered" : "",
              prompt: { title: "Enter Extra Expenses", submit: "Save", fields: [{ k: "amount", l: "Extra expenses (₹)", t: "num", req: true, min: 0 }] },
            },
            { id: "gst", l: "Change GST", why: d.verification === "Verified" ? "The line has been dispatch-verified" : "", prompt: { title: "GST", submit: "Save", fields: [{ k: "gst", l: "GST", t: "select", req: true, opts: ["18%", "0%"] }], init: { gst: d.gstBp ? "18%" : "0%" } } },
            { id: "select", l: "Select Order Number", href: `?f=${encodeURIComponent((byNo.get(l.o.orderNo) ?? []).join(","))}&fl=${encodeURIComponent(`Order ${l.o.orderNo}`)}` },
            { id: "view", l: "View order", href: `/erp/orders?open=${l.o.id}` },
          ];
          const credit = l.billing.creditDays ?? null;
          return {
            id: l.o.id,
            v: withoutHidden(
              {
                follow: d.transportFollowUp,
                date: l.o.orderDate,
                orderNo: String(l.o.orderNo),
                billing: l.billing.name,
                sku: l.sku.name,
                rate: l.o.ratePaise,
                billTotal: billTotal.get(`${l.o.orderNo}|${l.o.billingCustomerId}`) ?? null,
                discount: l.o.discountBp == null ? null : l.o.discountBp / 100,
                dispatchDate: d.dispatchDate,
                verification: d.verification ?? "Pending",
                qty: l.o.qtyCans,
                monthly: r.monthId ? monthSale : null,
                amount: r.amount,
                si: l.si,
                discounted: r.discounted,
                orderId: l.o.id,
                area: l.delivery.area,
                transporter: l.o.transporter ?? l.delivery.p?.transporter ?? null,
                transport: l.o.transportCostPaise,
                extra: d.extraExpensesPaise,
                bill: l.o.tallyBillNo,
                payment: l.billing.freightTerm,
                margin: r.margin,
                monthId: r.monthId,
                godown: l.godown,
              } as Record<string, CellValue>,
              hiddenKeys,
            ),
            flags,
            title: `${l.billing.name} · order ${l.o.orderNo}`,
            header: `${l.sku.name} · ${nf(l.o.qtyCans)} cans${d.dispatchDate ? ` · dispatched ${fd(d.dispatchDate)}` : ""}`,
            fields: [
              { l: "Delivery party", v: l.delivery.name },
              { l: "Type", v: l.type === "Drum" ? "Drum" : "Can", der: true },
              { l: "Quantity dispatch in litre", v: nf(r.litres), der: true },
              { l: "GST", v: d.gstBp ? "18%" : "0%" },
              { l: "Company", v: r.company, der: true },
              ...(amounts ? [{ l: "Final amount", v: r.final == null ? "—" : inr(r.final), der: true }] : []),
              ...(cost
                ? [
                    { l: "Lot-code costing", v: r.costing == null ? "—" : inr(r.costing), der: true },
                    { l: "Cost price per can", v: r.costing == null ? "—" : inr(Math.round(r.costing / l.o.qtyCans)), der: true },
                    { l: "Credit note amount", v: d.creditNotePaise == null ? "—" : inr(d.creditNotePaise) },
                  ]
                : []),
              { l: "Order fulfil days", v: d.dispatchDate ? String(daysBetween(l.o.orderDate, d.dispatchDate)) : "—", der: true },
              { l: "Credit days", v: credit == null ? "—" : String(credit), der: true },
              { l: "Due date", v: d.dispatchDate && credit != null ? fd(addDaysIso(d.dispatchDate, credit)) : "—", der: true },
              { l: "Segment and counter type", v: `${l.delivery.p?.segment ?? ""} ${(l.delivery.p?.counterTypes ?? []).join(", ")}`.trim() || "—", der: true },
              { l: "Sales man", v: l.delivery.salesPerson ?? "—", der: true },
              ...(amounts ? [{ l: "Monthly target", v: target == null ? "—" : inr(target), der: true }] : []),
              { l: "Dispatch status", v: d.dispatchStatus },
            ],
            actions,
            by: stampLine(null, d.createdAt).replace(/^Created/, "Added to order details"),
          };
        }),
    };
  },
  bulk: {
    verify: (ctx, ids, values) => verify(ctx, ids, values),
    extra: (ctx, ids, values) => extra(ctx, ids, values),
  },
  actions: {
    verify: (ctx, id, values) => verify(ctx, [id], values),
    extra: (ctx, id, values) => extra(ctx, [id], values),
    async notVerify(ctx, id) {
      if (!ctx.administrator) return err("Only an administrator marks a line Not Verify.", "not_permitted");
      await db.update(erpOrderDetails).set({ verification: "Not Verify", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpOrderDetails.orderId, id));
      await erpAudit(ctx, "erp.detail.notVerify", "erp_order_detail", id);
      return okVoid("Marked Not Verify");
    },
    async gst(ctx, id, values) {
      const gst = values.gst === "0%" ? 0 : values.gst === "18%" ? 1800 : null;
      if (gst == null) return fieldErr("gst", "GST is required");
      const [d] = await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, id));
      if (!d) return err("That line is not in order details.", "not_found");
      if (d.verification === "Verified") return err("The line has been dispatch-verified.", "rule_violation");
      await db.update(erpOrderDetails).set({ gstBp: gst, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpOrderDetails.orderId, id));
      await erpAudit(ctx, "erp.detail.gst", "erp_order_detail", id, { gstBp: d.gstBp }, { gstBp: gst });
      return okVoid(`GST ${values.gst} · billed by ${gst ? "Mahek Marketing India" : "Mylac"}`);
    },
  },
};

/** Do Verified: dispatch date, Verified, Dispatched, stamped — for lines whose lots are allocated in full. */
async function verify(ctx: ErpContext, ids: string[], values: Record<string, string>): Promise<Result<unknown>> {
  const date = text(values.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fieldErr("date", "Dispatch date is required");
  const ls = await lines(ids);
  const details = await db.select().from(erpOrderDetails).where(inArray(erpOrderDetails.orderId, ids));
  const d = new Map(details.map((x) => [x.orderId, x]));
  const ok = ls.filter((l) => {
    const v = d.get(l.o.id)?.verification;
    return d.has(l.o.id) && (!v || v === "Pending") && l.allocations > 0 && l.allocation === "Done";
  });
  if (!ok.length) return err("Nothing to verify: a line needs its lots allocated in full and must not be verified already.", "rule_violation");
  const earlier = ok.find((l) => date < l.o.orderDate);
  if (earlier) return fieldErr("date", `Order ${earlier.o.orderNo} was taken on ${fd(earlier.o.orderDate)}; it cannot leave before that`);
  await db.transaction(async (tx) => {
    await tx
      .update(erpOrderDetails)
      .set({ verification: "Verified", dispatchStatus: "Dispatched", dispatchedAt: new Date(), dispatchDate: date, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpOrderDetails.orderId, ok.map((l) => l.o.id)));
    /* §18: a bill's first verified line opens its transport follow-up, once per
       order number — the unique index is what makes "once" hold. */
    for (const l of ok)
      await tx
        .insert(erpTransports)
        .values({
          id: l.o.id,
          orderNo: l.o.orderNo,
          billDate: date,
          billingCustomerId: l.o.billingCustomerId,
          billNo: l.o.tallyBillNo,
          transporter: l.o.transporter ?? l.delivery.p?.transporter ?? null,
          area: l.delivery.area,
          paymentType: l.billing.freightTerm,
          extraExpensePaise: d.get(l.o.id)?.extraExpensesPaise ?? null,
          updatedById: ctx.user.id,
        })
        .onConflictDoNothing();
  });
  await erpAudit(ctx, "erp.detail.verify", "erp_order_detail", ok.map((l) => l.o.id).join(","), null, { dispatchDate: date });
  return okVoid(ok.length < ids.length ? `${plural(ok.length)} verified · ${ids.length - ok.length} not ready to verify` : `${plural(ok.length)} verified and dispatched`);
}

async function extra(ctx: ErpContext, ids: string[], values: Record<string, string>): Promise<Result<unknown>> {
  const amount = paise(values.amount);
  if (amount == null || amount < 0) return fieldErr("amount", "Extra expenses are required");
  const res = await db
    .update(erpOrderDetails)
    .set({ extraExpensesPaise: amount, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(and(inArray(erpOrderDetails.orderId, ids), sql`${erpOrderDetails.extraExpensesPaise} is null`))
    .returning({ id: erpOrderDetails.orderId });
  if (!res.length) return err("Extra expenses are already entered on these lines.", "rule_violation");
  await erpAudit(ctx, "erp.detail.extra", "erp_order_detail", res.map((r) => r.id).join(","), null, { amount });
  return okVoid(`Extra expenses on ${plural(res.length)}`);
}

export const SALES_SCREENS: ScreenModule[] = [orderList("orders"), orderList("pendingOrders"), orderList("readyOrders"), batchCodes, orderList("labels"), orderDetails];
