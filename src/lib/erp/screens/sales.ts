import "server-only";
import { randomUUID } from "node:crypto";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  erpBatchCodes,
  erpFollowups,
  erpGodowns,
  erpOrderDetails,
  erpOrderReviews,
  erpOrders,
  erpTransports,
  priceListDiscountTerms,
  priceListRates,
  priceLists,
  products,
  users,
  type PriceDiscountKind,
} from "@/db/schema";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import { resolvePriceList, type CustomerGeo } from "@/lib/engines/price-resolution";
import { discountTermSentence } from "@/lib/price-list-labels";
import { weightFor } from "@/lib/catalogue";
import { stamp } from "@/lib/format";
import { activeScopesAndLists, geographyOf } from "@/lib/services/price-list-service";
import type { ErpContext } from "../access";
import { knownTransporterName } from "../transporter-rename";
import { erpAudit, erpId, int, nextNumber, num, paise, rupeesField, stampLine, text, visibleCols, withoutHidden, type ScreenModule } from "../server";
import { newFormIn } from "../lazy-forms";
import type { ActionSpec, BulkSpec, CellValue, FieldSpec, FormSpec, ListRow } from "../ui";
import { fd, inr, nf, withFills } from "../ui";
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
  readyStockCheck,
  standingInstructions,
  targetReached,
  type Allocation,
  type OrderType,
} from "../engines/sales";
import { fgLevelAvailable, fgLots, fgRates, lockLot, packBatchCosting, packLots } from "../stock";
import { erpOrdersLive, orderNosOf, syncBookOrders } from "../book";
import { erpLink } from "../registry";
import { pageMap, readOnceKeyed } from "../read-memo";
import { monthWindow } from "../period";
import { type LoadScope, tooWide, unscoped, windowWhere } from "../window";
import { issuedCreditNotes } from "./complaints";
import { type Col, godownField, godownIdByName, godownOptions, has, inTx, refuse, today } from "./common";
import { markDispatched, scanGateFor, scannedOnAllocation } from "../dispatch";
import { erpDispatchHref, erpLabelsHref, erpTraceHref, orderTraceCode } from "../trace-links";
import { notifyUsers } from "@/lib/notify";
import {
  billingOf,
  dispatchOf,
  invoiceChanges,
  invoiceKey,
  likelyDuplicate,
  logisticsOf,
  ORDER_SOURCES,
  orderBillBlockers,
  orderStatusOf,
  productionOf,
  splitForMove,
  type InvoiceSnapshot,
} from "../engines/order-flow";
import { assignTripsAtDispatch } from "../trips";
import { loadCustomers, partyStatus, type CustomerRow } from "./masters";
import { confirmImpact } from "@/lib/impact/registry";
import { impactBatchKey } from "@/lib/impact/batch-key";
import { readConfirmation } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * Sales orders (spec §11): the taken-order line, its lot allocations, the
 * label export and order details, where a line is billed and dispatched.
 *
 * Everything a detail line shows is read LIVE from its order line, as the
 * source reads it; the detail row holds only what dispatch adds. A lot
 * allocation takes stock the moment it is written, under the lot's lock, and
 * deleting it gives the stock back.
 * ------------------------------------------------------------------------- */

export const ORDER_STATUSES = ["Under Process", "Ready", "Hold From Office", "Cancel"];

/** Where a line stands against the day it is planned to leave: said from the date, never typed. */
export type Due = "today" | "tomorrow" | "late" | null;

export function dueOf(dispatchOn: string | null, dispatched: boolean, status: string, now: string): Due {
  if (!dispatchOn || dispatched || status === "Cancel") return null;
  if (dispatchOn < now) return "late";
  if (dispatchOn === now) return "today";
  return dispatchOn === addDaysIso(now, 1) ? "tomorrow" : null;
}

const DUE_WORD: Record<NonNullable<Due>, string> = { today: "Dispatch today", tomorrow: "Dispatch tomorrow", late: "Dispatch late" };

/* ============================================================ the lines */

type Sku = {
  id: string;
  name: string;
  fgId: string | null;
  cpb: number;
  litresPerCan: number;
  /** One box's weight on a boxed SKU, one can's on a loose one or a drum — `weightBasis` says which. */
  weightGrams: number | null;
  weightBasis: "box" | "can";
  boxType: string | null;
  empty: number;
};

/* The catalogue and the price book are the same for every line on a page and are asked for by each sales reading; read once per page. */
function skuCatalogue(): Promise<Map<string, Sku>> {
  return readOnceKeyed("erp.skuCatalogue", readSkuCatalogue);
}

async function readSkuCatalogue(): Promise<Map<string, Sku>> {
  const rows = (await db.execute(sql`
    select p.id, p.name, p.finished_good_id as "fgId", p.cans_per_box as cpb,
           coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as "litresPerCan",
           p.weight_grams::float8 as "weightGrams", p.weight_basis::text as "weightBasis", pk.box_type as "boxType", coalesce(pk.empty_boxes_required, 0) as empty
      from products p
      left join finished_goods fg on fg.id = p.finished_good_id
      left join erp_product_packing pk on pk.product_id = p.id
  `)) as unknown as Sku[];
  return new Map(rows.map((r) => [r.id, { ...r, cpb: Number(r.cpb), litresPerCan: Number(r.litresPerCan ?? 0), weightGrams: r.weightGrams == null ? null : Number(r.weightGrams), empty: Number(r.empty) }]));
}

/** A boxed SKU sells from packing stock in boxes; a loose one from FG stock in cans. */
const isBoxed = (s: Sku) => s.empty > 0;

/**
 * WHAT A LINE WEIGHS, not what one of its SKU weighs. The catalogue stores a
 * box's weight on a boxed SKU and a can's on a loose one or a drum, and the
 * order screens printed that figure bare — so 64 one-litre cans in two boxes
 * of 32 read as 29 kg, the weight of one box. `weightFor` is the catalogue's
 * one rule for turning the stored figure into a quantity's: the box weight ×
 * the boxes (a part box still travels, so it rounds up), or the can weight ×
 * the order quantity where there is no box. The printed dispatch label keeps
 * the stored figure: a label goes on one box.
 */
function lineWeightKg(qtyCans: number, sku: Sku): number | null {
  const grams = weightFor(qtyCans, { cansPerBox: sku.cpb, millilitresPerCan: null, weightGrams: sku.weightGrams, weightBasis: sku.weightBasis });
  return grams == null ? null : Math.round(grams) / 1000;
}

/**
 * The price-list rate for a party and an SKU (spec §11.2), off the list THE
 * ACCOUNTS APP APPLIES to that party — `resolvePriceList`, the
 * rule its price-list screens and its variance report already price by: a
 * list named for the customer, then their salesman, beat, area, city,
 * district, state, customer type, everybody, narrowest wins. Then the SKU's
 * flat row on that list, or failing that a row for another SKU of the same FG
 * product, as the source looks up by FG product. A slab row is not a rate,
 * and a dash ("not for sale on this list") is the list saying so about that
 * SKU: no rate, and no borrowing one from its other packing either. The rate is the list's ex-GST rate,
 * because order details adds GST on top (decision recorded in the phase 4 PR).
 *
 * A list's discounts are SAID, never applied. Every kind a list can carry is
 * conditional — advance payment, prompt payment, a quantity, "other" — and the
 * old reading took a term with no threshold to be flat, which on prod is MP &
 * CG's 3% for advance payment: given to every order of theirs the day their
 * list started resolving. The form prints the terms; the person types the
 * discount the party has earned.
 *
 * It used to match the party's price TAG against a list's NAME. The tags are
 * the sheet's ("Pan Maharashtra", "WESTERN LINE") and the names are Accounts'
 * ("Western line Paid — 1 Aug 2026"), so on prod not one of 446 parties
 * matched and every rate was typed, while Accounts resolved a list for 206.
 *
 * Resolved as of TODAY on the form and on the save alike, so the rate a person
 * is shown is the rate that is written.
 */
type AppliedList = { id: string; name: string; /** Its discount terms, in the Accounts app's words: "3% off for advance payment". */ terms: string[] };

type PriceBook = {
  /** The list in force for this party, or null where none applies. */
  listOf: (customerId: string) => AppliedList | null;
  rateOf: (customerId: string, sku: Sku | undefined) => number | null;
};

async function priceBook(customerIds: Iterable<string>): Promise<PriceBook> {
  const [book, geo] = await Promise.all([readOnceKeyed("erp.priceBook", readPriceBook), partyGeography([...new Set(customerIds)])]);
  const day = today();
  const resolved = new Map<string, AppliedList | null>();
  const listOf = (customerId: string) => {
    if (!resolved.has(customerId)) {
      const g = geo.get(customerId);
      const r = g ? resolvePriceList(g, book.scopes, book.lists, day) : null;
      resolved.set(customerId, r ? { id: r.listId, name: r.listName, terms: book.terms.get(r.listId) ?? [] } : null);
    }
    return resolved.get(customerId)!;
  };
  return {
    listOf,
    rateOf(customerId, sku) {
      const list = listOf(customerId);
      return list && sku ? book.rateOf(list.id, sku) : null;
    },
  };
}

/** Every published list, its scopes, flat rates and discount terms: the half of the book that does not depend on the party. */
async function readPriceBook() {
  const [{ scopes, lists }, rates, terms] = await Promise.all([
    activeScopesAndLists(),
    db
      .select({ list: priceListRates.priceListId, sku: priceListRates.productId, fg: products.finishedGoodId, rate: priceListRates.rateExGstPaise, offered: priceListRates.offered })
      .from(priceListRates)
      .innerJoin(priceLists, eq(priceLists.id, priceListRates.priceListId))
      .leftJoin(products, eq(products.id, priceListRates.productId))
      .where(and(eq(priceLists.status, "published"), isNull(priceListRates.minCans))),
    db
      .select({ list: priceListDiscountTerms.priceListId, kind: priceListDiscountTerms.kind, percentBp: priceListDiscountTerms.percentBp, thresholdLitres: priceListDiscountTerms.thresholdLitres, thresholdPaise: priceListDiscountTerms.thresholdPaise })
      .from(priceListDiscountTerms)
      .innerJoin(priceLists, eq(priceLists.id, priceListDiscountTerms.priceListId))
      .where(eq(priceLists.status, "published"))
      .orderBy(asc(priceListDiscountTerms.percentBp), asc(priceListDiscountTerms.id)),
  ]);
  /* A dash is kept as null, so the SKU it names does not fall through to its FG product's rate. */
  const bySku = new Map<string, number | null>();
  const byFg = new Map<string, number>();
  for (const r of rates) {
    bySku.set(`${r.list}|${r.sku}`, r.offered ? Number(r.rate) : null);
    if (r.offered && r.fg && !byFg.has(`${r.list}|${r.fg}`)) byFg.set(`${r.list}|${r.fg}`, Number(r.rate));
  }
  const said = new Map<string, string[]>();
  for (const t of terms) said.set(t.list, [...(said.get(t.list) ?? []), discountTermSentence({ ...t, kind: t.kind as PriceDiscountKind, thresholdPaise: t.thresholdPaise == null ? null : Number(t.thresholdPaise) })]);
  const rateOf = (listId: string, sku: Sku) => {
    const own = bySku.get(`${listId}|${sku.id}`);
    if (own !== undefined) return own;
    return (sku.fgId ? byFg.get(`${listId}|${sku.fgId}`) : undefined) ?? null;
  };
  return { scopes, lists, terms: said, rateOf };
}

/** Where these parties are, for the price-list resolver — read by id, and within a page never one read twice. */
async function partyGeography(ids: string[]): Promise<Map<string, CustomerGeo>> {
  const known = pageMap<Promise<CustomerGeo | undefined>>("erp.partyGeography");
  if (!known) return geographyOf(ids);
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    const got = geographyOf(missing);
    for (const id of missing) known.set(id, got.then((m) => m.get(id)));
    got.catch(() => missing.forEach((id) => known.delete(id)));
  }
  const found = await Promise.all(ids.map((id) => known.get(id)));
  const out = new Map<string, CustomerGeo>();
  ids.forEach((id, i) => {
    const g = found[i];
    if (g) out.set(id, g);
  });
  return out;
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
  /** What the line weighs, in kg: a box's weight × its boxes, or a can's × its cans (`weightFor`). */
  weightKg: number | null;
  labels: number;
  allocated: number;
  allocations: number;
  allocation: Allocation;
  inDetails: boolean;
  /** Some line of the same order is in order details. */
  orderDetailed: boolean;
  /** Dispatch-verified: the goods have left. */
  dispatched: boolean;
  /** The independent invoice check on the billed line: Pending | Approved | Rejected, or null before billing. */
  invoiceCheck: string | null;
  invoiceCheckedById: string | null;
  invoiceCheckedAt: Date | null;
  invoiceCheckNote: string | null;
  /** Who billed the line — the person the invoice checker must not be. */
  billedById: string | null;
  gstBp: number | null;
  stickersAt: Date | null;
  vehicleNo: string | null;
  /** The bill's transport record, once the line has left. */
  transport: { stage: string | null; hasLr: boolean; issue: string | null } | null;
  due: Due;
  si: string;
  by: string | null;
};

/**
 * WHICH ORDER LINES TO READ — said in SQL, never filtered out of the whole
 * book in memory. The book is every line Mahek has ever sold (22,154 on the
 * day it was imported) and grows every day; reading it whole to draw one page,
 * three times a request for the badges, is what took the server past its heap.
 *
 *  - `openWork`: still being worked — not cancelled, and not both billed and
 *    dispatch-verified. Every working list, badge and dashboard tile is a
 *    subset of it, and it is as large as the godown's backlog, not the history.
 *  - `window`: a register's period (`window.ts`), on the order date or on the
 *    dispatch date. The record a link opens and the ids a tile names widen it.
 *  - `ids` / `orderNos`: exactly these, for an action, a form or one order's labels.
 *
 * Filters given together all apply. No filter at all is refused: there is no
 * caller that needs the whole book, and a default that read it would be the
 * one somebody forgets.
 */
export type LineFilter = {
  openWork?: boolean;
  window?: { scope: LoadScope; on: "order" | "dispatch" };
  ids?: string[];
  orderNos?: number[];
  /** Only lines that have reached order details (billed). */
  billed?: boolean;
};

/** Order lines with what the screens derive from them — the one reading every sales list shares. */
export async function orderLines(f: LineFilter): Promise<OrderLine[]> {
  return readOnceKeyed(`orderLines:${JSON.stringify(f)}`, () => readLines(f));
}

function lineWhere(f: LineFilter) {
  const where = [];
  if (f.ids) where.push(f.ids.length ? sql`${erpOrders.id} in ${f.ids}` : sql`false`);
  if (f.orderNos) where.push(f.orderNos.length ? sql`${erpOrders.orderNo} in ${f.orderNos}` : sql`false`);
  if (f.billed) where.push(sql`${erpOrderDetails.orderId} is not null`);
  if (f.openWork)
    where.push(sql`${erpOrders.status} <> 'Cancel' and not (${erpOrders.entryStatus} = 'Done' and ${erpOrderDetails.verification} is not distinct from 'Verified')`);
  if (f.window) where.push(windowWhere(f.window.on === "dispatch" ? sql`${erpOrderDetails.dispatchDate}` : sql`${erpOrders.orderDate}`, sql`${erpOrders.id}`, f.window.scope));
  if (!where.length) throw new Error("orderLines needs a filter: openWork, a window, ids or orderNos.");
  return sql.join(where, sql` and `);
}

/** How many lines a filter holds — one count, so a register can refuse a period too long to build. */
export async function countLines(f: LineFilter): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(erpOrders)
    .leftJoin(erpOrderDetails, eq(erpOrderDetails.orderId, erpOrders.id))
    .where(lineWhere(f));
  return Number(r?.n ?? 0);
}

async function readLines(f: LineFilter): Promise<OrderLine[]> {
  const rows = await db
    .select({
      o: erpOrders,
      godown: erpGodowns.name,
      by: users.name,
      verification: erpOrderDetails.verification,
      detailRow: sql<boolean>`${erpOrderDetails.orderId} is not null`,
      invoiceCheck: erpOrderDetails.invoiceCheck,
      invoiceCheckedById: erpOrderDetails.invoiceCheckedById,
      invoiceCheckedAt: erpOrderDetails.invoiceCheckedAt,
      invoiceCheckNote: erpOrderDetails.invoiceCheckNote,
      billedById: erpOrderDetails.createdById,
      gstBp: erpOrderDetails.gstBp,
      stickersAt: sql<Date | null>`coalesce(${erpOrders.stickersAt}, ${erpOrderDetails.stickersAt})`,
      vehicleNo: erpOrderDetails.vehicleNo,
      /* The bill's transport record, for the logistics word — one row by primary key. */
      transport: sql<{ stage: string | null; hasLr: boolean; issue: string | null } | null>`(select json_build_object('stage', t.material_stage, 'hasLr', (t.lr_id is not null or coalesce(t.lr_no, '') <> ''), 'issue', t.issue) from erp_transports t where t.id = "erp_order_details"."transport_id")`,
      /* Whether ANY line of this order has reached order details — the Pending
         list's rule. Asked in SQL because the other lines may be outside this read. */
      orderDetailed: sql<boolean>`exists (select 1 from erp_orders o2 join erp_order_details d2 on d2.order_id = o2.id where o2.order_no = "erp_orders"."order_no")`,
      allocQty: sql<number>`(select coalesce(sum(b.quantity), 0)::float8 from erp_batch_codes b where b.order_id = "erp_orders"."id")`,
      allocN: sql<number>`(select count(*)::int from erp_batch_codes b where b.order_id = "erp_orders"."id")`,
    })
    .from(erpOrders)
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpOrders.godownId))
    .leftJoin(users, eq(users.id, erpOrders.createdById))
    .leftJoin(erpOrderDetails, eq(erpOrderDetails.orderId, erpOrders.id))
    .where(lineWhere(f))
    .orderBy(desc(erpOrders.orderNo), desc(erpOrders.orderDate), asc(erpOrders.createdAt));
  if (!rows.length) return [];
  const [parties, skus] = await Promise.all([customersById([...new Set(rows.flatMap((r) => [r.o.billingCustomerId, r.o.deliveryCustomerId]))]), skuCatalogue()]);
  const now = today();
  const out: OrderLine[] = [];
  for (const r of rows) {
    const billing = parties.get(r.o.billingCustomerId);
    const delivery = parties.get(r.o.deliveryCustomerId) ?? billing;
    const sku = skus.get(r.o.skuId);
    if (!billing || !delivery || !sku) continue;
    const type = orderType(sku.boxType);
    const boxed = isBoxed(sku);
    const { boxes, valid } = boxQuantity(r.o.qtyCans, sku.cpb, !boxed);
    const allocated = Number(r.allocQty ?? 0);
    const verified = r.verification === "Verified";
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
      weightKg: lineWeightKg(r.o.qtyCans, sku),
      labels: labelCount(type, boxes, r.o.qtyCans),
      allocated,
      allocations: Number(r.allocN ?? 0),
      allocation: allocationState(allocationTarget(boxed, boxes, r.o.qtyCans), allocated),
      inDetails: !!r.detailRow,
      orderDetailed: !!r.orderDetailed,
      dispatched: verified,
      invoiceCheck: r.detailRow ? (r.invoiceCheck ?? "Pending") : null,
      invoiceCheckedById: r.invoiceCheckedById ?? null,
      invoiceCheckedAt: r.invoiceCheckedAt ? new Date(r.invoiceCheckedAt) : null,
      invoiceCheckNote: r.invoiceCheckNote ?? null,
      billedById: r.billedById ?? null,
      gstBp: r.gstBp == null ? null : Number(r.gstBp),
      stickersAt: r.stickersAt ? new Date(r.stickersAt) : null,
      vehicleNo: r.vehicleNo ?? null,
      transport: r.transport ? { stage: r.transport.stage ?? null, hasLr: !!r.transport.hasLr, issue: r.transport.issue ?? null } : null,
      due: dueOf(r.o.dispatchOn, verified, r.o.status, now),
      si: standingInstructions({ instructions: delivery.p?.standingInstructions ?? null, deliveryType: delivery.deliveryType, paymentType: delivery.freightTerm, weightType: delivery.p?.weightType ?? null }),
      by: r.by,
    });
  }
  return out;
}

/** The customers these lines name — never the whole customer book, and within a page never one read twice. */
async function customersById(ids: string[]): Promise<Map<string, CustomerRow>> {
  const known = pageMap<Promise<CustomerRow | undefined>>("erp.customersById");
  if (!known) return readCustomersById(ids);
  const missing = [...new Set(ids)].filter((id) => !known.has(id));
  if (missing.length) {
    const got = readCustomersById(missing);
    for (const id of missing) known.set(id, got.then((m) => m.get(id)));
    got.catch(() => missing.forEach((id) => known.delete(id)));
  }
  const found = await Promise.all(ids.map((id) => known.get(id)));
  const out = new Map<string, CustomerRow>();
  ids.forEach((id, i) => {
    const c = found[i];
    if (c) out.set(id, c);
  });
  return out;
}

async function readCustomersById(ids: string[]): Promise<Map<string, CustomerRow>> {
  const out = new Map<string, CustomerRow>();
  for (let i = 0; i < ids.length; i += 1000) for (const c of await loadCustomers(inArray(customers.id, ids.slice(i, i + 1000)), { any: true })) out.set(c.id, c);
  return out;
}

/** The orders some of these lines belong to that have a billed line — the Pending list's rule, read off the lines. */
export function detailedOrdersOf(lines: OrderLine[]): Set<number> {
  return new Set(lines.filter((l) => l.orderDetailed).map((l) => l.o.orderNo));
}

/**
 * Why an ORDER cannot be billed yet, in the order the office has to fix them,
 * read off every line of it (`orderBillBlockers`). One order is one complete
 * bill (PRD rule 1): the order is billed whole, once the back office has
 * verified it and every line not cancelled is Ready. A line that will go later
 * is moved to a new, linked order instead of holding the bill (rule 2).
 *
 * Mahek Plus asked for "Done" and then "Add To Order Details" for one fact;
 * billing is one step, and it records the Tally invoice number as it happens.
 */
export function billBlockersFor(order: OrderLine[]): string[] {
  return orderBillBlockers(
    order.map((l) => ({
      id: l.o.id,
      label: l.sku.name,
      status: l.o.status,
      orderCheck: l.o.orderCheck,
      partyPending: l.o.partyStatus === "Pending",
      ratePaise: l.o.ratePaise,
      billed: l.inDetails,
    })),
  );
}

/** The PRD's separate status words for one line (rule 4): each its own domain, none overwriting another. */
export function lineDomains(l: OrderLine, toScan: string | null = null) {
  const facts = { status: l.o.status, orderCheck: l.o.orderCheck, billed: l.inDetails, invoiceCheck: l.invoiceCheck, toScan, dispatched: l.dispatched, transport: l.transport };
  return { order: orderStatusOf(facts), production: productionOf(l.o.status), billing: billingOf(facts), dispatch: dispatchOf(facts), logistics: logisticsOf(facts) };
}

function lineFlags(l: OrderLine): string[] {
  const f: string[] = [];
  if (l.o.status !== "Cancel" && !l.inDetails) {
    if (l.o.orderCheck === "Correction") f.push("orderCorrection");
    else if (l.o.orderCheck !== "Verified") f.push("orderToVerify");
  }
  if (l.o.status === "Under Process") f.push("underProcess");
  if (l.o.status === "Ready" && l.o.entryStatus !== "Done") f.push(l.allocation === "Done" ? "readyAlloc" : "readyShort");
  if (!l.inDetails && l.o.ratePaise == null) f.push("billMissing");
  if (l.o.partyStatus === "Pending") f.push("pendingParty");
  if (l.inDetails && !l.dispatched) f.push(l.invoiceCheck === "Approved" ? "invoiceApproved" : l.invoiceCheck === "Rejected" ? "invoiceRejected" : "invoiceToCheck");
  if (l.o.linkedFromOrderNo) f.push("linkedOrder");
  if (l.due) f.push(l.due === "today" ? "dueToday" : l.due === "tomorrow" ? "dueTomorrow" : "late");
  return f;
}

/* ===================================================== the order's checks */

type Tx0 = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What the invoice checker is shown, and what a later change is measured against. */
function invoiceSnapshot(order: OrderLine[]): InvoiceSnapshot {
  const billed = order.filter((l) => l.inDetails && l.o.status !== "Cancel");
  const first = billed[0] ?? order[0];
  return {
    invoiceNo: first?.o.tallyBillNo ?? null,
    invoiceDate: first?.o.invoiceDate ?? null,
    lines: billed.map((l) => ({ id: l.o.id, skuId: l.o.skuId, qtyCans: l.o.qtyCans, ratePaise: l.o.ratePaise, discountBp: l.o.discountBp, gstBp: l.gstBp })),
  };
}

/** A line of the order's check history (`erp_order_reviews`), appended and never edited. */
async function addReview(
  tx: Tx0 | typeof db,
  ctx: ErpContext,
  orderNo: number,
  kind: "order" | "invoice",
  result: "submitted" | "verified" | "correction" | "approved" | "rejected" | "reset",
  note: string | null,
  snapshot: Record<string, unknown> = {},
) {
  await tx.insert(erpOrderReviews).values({ id: erpId("orv"), orderNo, kind, result, note, snapshot, byId: ctx.user.id });
}

export type OrderReview = { orderNo: number; kind: string; result: string; note: string | null; by: string | null; at: Date };

/** The check history of these orders, newest first. */
export async function reviewsFor(orderNos: number[]): Promise<Map<number, OrderReview[]>> {
  const out = new Map<number, OrderReview[]>();
  if (!orderNos.length) return out;
  const rows = await db
    .select({ orderNo: erpOrderReviews.orderNo, kind: erpOrderReviews.kind, result: erpOrderReviews.result, note: erpOrderReviews.note, by: users.name, at: erpOrderReviews.at })
    .from(erpOrderReviews)
    .leftJoin(users, eq(users.id, erpOrderReviews.byId))
    .where(inArray(erpOrderReviews.orderNo, [...new Set(orderNos)]))
    .orderBy(desc(erpOrderReviews.at));
  for (const r of rows) out.set(r.orderNo, [...(out.get(r.orderNo) ?? []), r]);
  return out;
}

const REVIEW_WORD: Record<string, string> = {
  submitted: "sent to check",
  verified: "verified",
  correction: "sent back for correction",
  approved: "approved",
  rejected: "rejected",
  reset: "back to check",
};

/** "Invoice approved by Pooja · 26 Oct, 14:05 — rate corrected" — one history line. */
export function reviewLine(r: OrderReview): string {
  const when = stamp(r.at);
  return `${r.kind === "order" ? "Order" : "Invoice"} ${REVIEW_WORD[r.result] ?? r.result}${r.by ? ` by ${r.by}` : ""} · ${when}${r.note ? ` — ${r.note}` : ""}`;
}

/** The people who hold a power by grant — who is told when work for that power arrives. Administrators read their lists. */
async function holdersOf(power: string): Promise<string[]> {
  const rows = (await db.execute(sql`select p.user_id as id from erp_user_powers p join users u on u.id = p.user_id where p.power = ${power} and u.active`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

async function tell(userIds: (string | null | undefined)[], title: string, body: string, href: string, kind: "info" | "warn" = "info") {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  await notifyUsers(ids.map((userId) => ({ userId, title, body, href, kind }))).catch(() => undefined);
}

/**
 * A MATERIAL CHANGE TO AN UNBILLED ORDER GOES BACK TO THE BACK OFFICE. Once
 * verified, a changed quantity, delivery party, rate, discount or an added line
 * is not what was verified, so the order is Pending again and the history says
 * why. A billed order is the invoice checker's to look at instead.
 */
async function reopenOrderCheck(ctx: ErpContext, orderNo: number, why: string) {
  const order = (await orderLines({ orderNos: [orderNo] })).filter((l) => l.o.status !== "Cancel");
  if (!order.length || order.some((l) => l.inDetails)) return;
  const was = order[0].o.orderCheck;
  if (was === "Pending") return;
  await db.transaction(async (tx) => {
    await tx.update(erpOrders).set({ orderCheck: "Pending", updatedAt: new Date(), updatedById: ctx.user.id }).where(and(eq(erpOrders.orderNo, orderNo), sql`${erpOrders.status} <> 'Cancel'`));
    await addReview(tx, ctx, orderNo, "order", was === "Correction" ? "submitted" : "reset", why);
  });
}

/**
 * ANY CHANGE TO AN INVOICE'S FIGURES AFTER IT WAS CHECKED SENDS IT BACK
 * (PRD step 6). `before` is the snapshot taken before the write; nothing is
 * reset where the figures did not move. A rejected invoice that is corrected
 * goes back to the checker the same way.
 */
async function reopenInvoiceCheck(ctx: ErpContext, orderNo: number, before: InvoiceSnapshot) {
  const order = await orderLines({ orderNos: [orderNo] });
  const billed = order.filter((l) => l.inDetails && !l.dispatched);
  if (!billed.length) return;
  const was = billed[0].invoiceCheck;
  if (was === "Pending") return;
  const changed = invoiceChanges(before, invoiceSnapshot(order));
  if (!changed.length) return;
  await db.transaction(async (tx) => {
    await tx
      .update(erpOrderDetails)
      .set({ invoiceCheck: "Pending", invoiceCheckedById: null, invoiceCheckedAt: null, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpOrderDetails.orderId, billed.map((l) => l.o.id)));
    await addReview(tx, ctx, orderNo, "invoice", was === "Rejected" ? "submitted" : "reset", `Changed: ${changed.join(", ")}`, invoiceSnapshot(order) as unknown as Record<string, unknown>);
  });
  await tell(await holdersOf("checkInvoices"), `Invoice to check again · order ${orderNo}`, `${billed[0].billing.name}: ${changed.join(", ")}.`, erpLink("invoiceCheck", {}));
}

/* ============================================================== forms */

export async function orderForm(ctx: ErpContext, fixed?: { orderNo: number; date: string; godown: string; billing: string; delivery: string; transporter: string; source: string }): Promise<FormSpec> {
  const [gds, parties, shops, skus] = await Promise.all([godownOptions(ctx, { lost: false }), loadCustomers(), thirdPartyShops(), skuCatalogue()]);
  const active = parties.filter((p) => partyStatus(p) !== "Deactive");
  const names = active.map((p) => p.name);
  const deliveryNames = withShops(names, shops);
  const party: Record<string, { a: string; si: string; t: string }> = {};
  for (const p of [...shops, ...active])
    party[p.name] = {
      a: p.area ?? "",
      si: standingInstructions({ instructions: p.p?.standingInstructions ?? null, deliveryType: p.deliveryType, paymentType: p.freightTerm, weightType: p.p?.weightType ?? null }),
      t: p.p?.transporter ?? "",
    };
  const skuList = [...skus.values()].sort((a, b) => a.name.localeCompare(b.name));
  const cpb: Record<string, number> = {};
  const loose: Record<string, boolean> = {};
  for (const s of skuList) {
    cpb[s.name] = s.cpb;
    loose[s.name] = !isBoxed(s);
  }
  const seeRate = ctx.powers.has("viewSalesRate");
  const seeAmounts = ctx.powers.has("viewSalesAmounts");
  const pricing = seeRate || seeAmounts ? await priceFills(active, skuList) : null;
  /* "Add to order" opens with its party chosen, so its price list is filled now rather than on a pick that never comes. */
  return withFills({
    screen: "orders",
    id: fixed ? "more" : "new",
    title: fixed ? `Add to order ${fixed.orderNo}` : "New sales order",
    sub: fixed
      ? "One line per SKU. A verified order goes back to the back office to verify again once a line is added."
      : "One line per SKU. The back office verifies the order before production can mark it Ready. The rate fills in from the price list the Accounts app applies to the billing party; type it where the list has none.",
    submit: "Save order",
    lineLabel: "SKU",
    init: fixed
      ? { orderFixed: String(fixed.orderNo), date: fixed.date, godown: fixed.godown, billing: fixed.billing, delivery: fixed.delivery, transporter: fixed.transporter, source: fixed.source }
      : { date: today(), godown: ctx.workingGodown?.name ?? "" },
    data: { party, cpb, loose },
    header: [
      { k: "orderNo", l: "Order number", t: "derived", calc: "order.no" },
      { k: "date", l: "Date", t: "date", req: true, readOnly: !!fixed },
      { k: "source", l: "Order received by", t: "select", req: true, opts: [...ORDER_SOURCES], readOnly: !!fixed && !!fixed.source, hint: "WhatsApp, a phone call or a Sales Order." },
      godownField(gds, { readOnly: !!fixed }),
      { k: "billing", l: "Billing party", t: "select", req: true, opts: names, readOnly: !!fixed },
      { k: "delivery", l: "Delivery party", t: "select", opts: deliveryNames, hint: "Blank delivers to the billing party. Third-party shops are listed too.", readOnly: !!fixed },
      { k: "area", l: "Area", t: "derived", calc: "order.area" },
      { k: "si", l: "Standing instructions", t: "derived", calc: "order.si" },
      { k: "transporter", l: "Transporter", t: "text", hint: "Blank uses the delivery party's transporter." },
      { k: "dispatchOn", l: "Dispatch on", t: "date", hint: "The day it should leave — the requested date, if the customer gave one. The lists say today, tomorrow or late from it." },
      ...(pricing ? ([{ k: "priceList", l: "Price list", t: "text", readOnly: true, untagged: true, fillBy: { by: ["billing"], map: pricing.list, otherwise: "" } }] as FieldSpec[]) : []),
      ...(pricing && seeAmounts
        ? ([{ k: "listTerms", l: "List discounts", t: "text", readOnly: true, untagged: true, wide: true, hint: "Each depends on how the party pays or how much it takes, so none is applied for you: type the discount on the line.", fillBy: { by: ["billing"], map: pricing.terms, otherwise: "" } }] as FieldSpec[])
        : []),
      ...(fixed
        ? []
        : ([
            {
              k: "dupOk",
              l: "Not a duplicate",
              t: "select",
              opts: [DUP_OK],
              hint: "Only asked for when this party already has an order today with exactly these goods.",
            },
          ] as FieldSpec[])),
    ],
    line: [
      { k: "sku", l: "Description of goods", t: "select", req: true, opts: skuList.map((s) => s.name) },
      { k: "qty", l: "Order qty (cans)", t: "num", req: true, min: 1 },
      { k: "boxes", l: "Box quantity", t: "derived", calc: "order.boxes" },
      ...(seeRate && pricing
        ? ([{ k: "rate", l: "Rate (₹)", t: "num", min: 0, hint: "From the price list. Blank where it has no rate for this SKU: type one.", fillBy: { by: ["priceList", "sku"], map: pricing.rate, otherwise: "" } }] as FieldSpec[])
        : []),
      ...(seeAmounts ? ([{ k: "discount", l: "Discount %", t: "num", min: 0, max: 100 }] as FieldSpec[]) : []),
      { k: "remark", l: "Remark / customer instructions", t: "area", mic: true },
    ],
  });
}

const DUP_OK = "Yes — it is a separate order";

/**
 * What the order form fills in from the price lists: each party's list by
 * name, its discount terms, and each list's rate for each SKU keyed on that
 * name. A party none applies to is named as such rather than left blank, so
 * picking it clears the rates the previous party's list filled in.
 */
async function priceFills(active: CustomerRow[], skuList: Sku[]): Promise<{ list: Record<string, string>; terms: Record<string, string>; rate: Record<string, string> }> {
  const prices = await priceBook(active.map((p) => p.id));
  const label = new Map<string, string>();
  const taken = new Set<string>();
  const list: Record<string, string> = {};
  const terms: Record<string, string> = {};
  const rate: Record<string, string> = {};
  for (const p of active) {
    const l = prices.listOf(p.id);
    if (l && !label.has(l.id)) {
      /* Two published lists can share a name; the rates are keyed on it, so it has to be unique here. */
      let name = l.name;
      for (let n = 2; taken.has(name); n++) name = `${l.name} (${n})`;
      taken.add(name);
      label.set(l.id, name);
      for (const s of skuList) {
        const r = prices.rateOf(p.id, s);
        if (r != null) rate[`${name}|${s.name}`] = rupeesField(r);
      }
    }
    list[p.name] = l ? label.get(l.id)! : NO_PRICE_LIST;
    terms[p.name] = l?.terms.length ? l.terms.join(" · ") : l ? "None on this list" : "";
  }
  return { list, terms, rate };
}

const NO_PRICE_LIST = "None applies to this party";

async function editForm(ctx: ErpContext, id: string): Promise<FormSpec | null> {
  const [l] = await orderLines({ ids: [id] });
  if (!l) return null;
  const [book, shops] = await Promise.all([loadCustomers(), thirdPartyShops()]);
  const names = withShops(book.filter((p) => partyStatus(p) !== "Deactive").map((p) => p.name), shops);
  const seeRate = ctx.powers.has("viewSalesRate");
  const seeAmounts = ctx.powers.has("viewSalesAmounts");
  const locked = l.inDetails || l.allocations > 0;
  return {
    screen: "orders",
    id: "edit",
    recordId: id,
    title: `Edit order ${l.o.orderNo} · ${l.sku.name}`,
    sub: [
      locked ? "Lots are allocated to this line, so its SKU is fixed." : "",
      l.inDetails
        ? "Billed: a change to the rate or discount sends the invoice back to the checker. The invoice number is changed from the order's Change invoice."
        : l.o.orderCheck === "Verified"
          ? "Verified: a change to the quantity, delivery party, rate or discount sends the order back to the back office."
          : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined,
    submit: "Save line",
    init: {
      status: ORDER_STATUSES.includes(l.o.status) ? l.o.status : "Under Process",
      dispatchOn: l.o.dispatchOn ?? "",
      delivery: l.delivery.name,
      transporter: l.o.transporter ?? "",
      qty: String(l.o.qtyCans),
      rate: rupeesField(l.o.ratePaise),
      discount: l.o.discountBp == null ? "" : String(l.o.discountBp / 100),
      transport: rupeesField(l.o.transportCostPaise),
      remark: l.o.remark ?? "",
    },
    header: [
      { k: "status", l: "Status", t: "select", req: true, opts: ORDER_STATUSES, sec: "Order", hint: "Under Process and Ready are production's; Hold From Office and Cancel are the order's." },
      { k: "dispatchOn", l: "Dispatch on", t: "date", hint: "Blank: not planned yet." },
      { k: "delivery", l: "Delivery party", t: "select", req: true, opts: names, readOnly: l.inDetails },
      { k: "transporter", l: "Transporter", t: "text" },
      { k: "qty", l: "Order qty (cans)", t: "num", req: true, min: 1, readOnly: l.inDetails, sec: "Quantity and price" },
      ...(seeRate ? ([{ k: "rate", l: "Rate (₹)", t: "num", min: 0 }] as FieldSpec[]) : []),
      ...(seeAmounts ? ([{ k: "discount", l: "Discount %", t: "num", min: 0, max: 100 }] as FieldSpec[]) : []),
      { k: "transport", l: "Freight charged to the customer (₹)", t: "num", min: 0, sec: "Billing", hint: "Added to the bill. Not the transport payment, which Logistics records against the trip." },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

/**
 * THE WHOLE ORDER IN ONE MODAL. "Edit" changes one line, and an order of seven
 * SKUs was seven trips through it — with no way to add a line or take one off
 * from the same place. This is the New order form opened on the order as it
 * stands: its delivery, transporter and dispatch day above, every live line
 * below, each line carrying its own id so the save knows which row it is.
 * What the order was raised as — its date, godown, billing party and source —
 * is shown and fixed; a different billing party is a different order.
 */
async function editOrderForm(ctx: ErpContext, id: string): Promise<FormSpec | null> {
  const [one] = await lines([id]);
  if (!one) return null;
  const all = (await orderLines({ orderNos: [one.o.orderNo] })).filter((l) => l.o.status !== "Cancel");
  if (!all.length) return null;
  const first = all[0];
  const billed = all.some((l) => l.inDetails);
  const base = await orderForm(ctx, {
    orderNo: first.o.orderNo,
    date: first.o.orderDate,
    godown: first.godown,
    billing: first.billing.name,
    delivery: first.delivery.name,
    transporter: first.o.transporter ?? "",
    source: first.o.orderSource ?? "",
  });
  const seeRate = ctx.powers.has("viewSalesRate");
  const seeAmounts = ctx.powers.has("viewSalesAmounts");
  return withFills({
    ...base,
    id: "editOrder",
    recordId: id,
    title: `Edit order ${first.o.orderNo} · ${first.billing.name}`,
    sub: [
      billed
        ? "Billed: the delivery party and quantities are fixed and no line can be added; a change to a rate or discount sends the invoice back to the checker."
        : first.o.orderCheck === "Verified"
          ? "Verified: a change to a quantity, the delivery party, a rate or a discount — or a line added or removed — sends the order back to the back office."
          : "Change any line, add a SKU, or remove a line.",
      all.some((l) => l.allocations > 0) ? "A line with lots allocated keeps its SKU and cannot be removed until its batch codes are released." : "",
    ]
      .filter(Boolean)
      .join(" "),
    submit: "Save order",
    init: { ...base.init, dispatchOn: first.o.dispatchOn ?? "", delivery: first.delivery.name, transporter: first.o.transporter ?? "" },
    header: base.header.map((f) => (f.k === "delivery" ? { ...f, readOnly: billed } : f.k === "dispatchOn" || f.k === "transporter" ? { ...f, readOnly: false } : f)),
    initLines: all.map((l) => ({
      lineId: l.o.id,
      sku: l.sku.name,
      qty: String(l.o.qtyCans),
      ...(seeRate ? { rate: rupeesField(l.o.ratePaise) } : {}),
      ...(seeAmounts ? { discount: l.o.discountBp == null ? "" : String(l.o.discountBp / 100) } : {}),
      remark: l.o.remark ?? "",
    })),
  });
}

/**
 * Saves the whole-order modal: lines that came back with their id are edited
 * through `saveEdit` — the same rules, audit and re-verification as editing one
 * line — lines with no id are added through `saveOrder`, and lines that did not
 * come back are removed. Everything that can be refused is checked BEFORE the
 * first write, so a refusal on line five does not leave lines one to four saved.
 */
async function saveEditOrder(ctx: ErpContext, h: Record<string, string>, ls: Record<string, string>[], id?: string): Promise<Result<unknown>> {
  if (!id) return err("No order named.", "not_found");
  const [one] = await lines([id]);
  if (!one) return err("That order no longer exists.", "not_found");
  const all = (await orderLines({ orderNos: [one.o.orderNo] })).filter((l) => l.o.status !== "Cancel");
  const byId = new Map(all.map((l) => [l.o.id, l]));
  const billed = all.some((l) => l.inDetails);
  if (!ls.length) return err("An order keeps at least one line. To drop the whole order, cancel it.", "rule_violation");

  const kept: { i: number; l: OrderLine; v: Record<string, string> }[] = [];
  const added: { i: number; v: Record<string, string> }[] = [];
  const replaced: OrderLine[] = [];
  for (let i = 0; i < ls.length; i++) {
    const v = ls[i];
    const l = v.lineId ? byId.get(v.lineId) : undefined;
    if (v.lineId && !l) return err("A line on this order changed while it was open. Close it and open the order again.", "rule_violation");
    if (!l) {
      added.push({ i, v });
      continue;
    }
    if ((v.sku ?? "") !== l.sku.name) {
      if (l.inDetails) return fieldErr(`l${i}.sku`, "This line is billed; its SKU is fixed");
      if (l.allocations) return fieldErr(`l${i}.sku`, "Lots are allocated to this line, so its SKU is fixed");
      replaced.push(l);
      added.push({ i, v });
      continue;
    }
    const qty = int(v.qty);
    if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, "Minus Quantity Not Allowed");
    if (l.inDetails && qty !== l.o.qtyCans) return fieldErr(`l${i}.qty`, "This line is billed; its quantity is fixed");
    if (!boxQuantity(qty, l.sku.cpb, !l.boxed).valid) return fieldErr(`l${i}.qty`, "INVALID");
    const d = num(v.discount);
    if (ctx.powers.has("viewSalesAmounts") && d != null && (d < 0 || d > 100)) return fieldErr(`l${i}.discount`, "Discount must be between 0 and 100");
    kept.push({ i, l, v });
  }
  const keptIds = new Set(kept.map((k) => k.l.o.id));
  const removed = [...all.filter((l) => !keptIds.has(l.o.id) && !replaced.includes(l))];
  for (const l of [...removed, ...replaced]) {
    if (l.inDetails) return err(`${l.sku.name} is billed and cannot be taken off; undo its billing first.`, "rule_violation");
    if (l.allocations) return err(`${l.sku.name} has lots allocated; release its batch codes before taking it off.`, "rule_violation");
  }
  if (added.length && billed) return err(`Order ${one.o.orderNo} is billed. One order is one bill — take a new order for these goods.`, "rule_violation");

  /* Added lines first: saveOrder checks every one of them before it writes any. */
  if (added.length) {
    const head = all[0] ?? one;
    const res = await saveOrder(
      ctx,
      {
        orderFixed: String(one.o.orderNo),
        date: head.o.orderDate,
        godown: head.godown,
        billing: head.billing.name,
        delivery: text(h.delivery) ?? head.delivery.name,
        transporter: h.transporter ?? "",
        dispatchOn: h.dispatchOn ?? "",
        source: head.o.orderSource ?? "",
      },
      added.map((a) => a.v),
    );
    if (!res.ok) {
      const fe = res.fieldErrors?.[0];
      const m = fe?.field.match(/^l(\d+)\.(.+)$/);
      return m ? fieldErr(`l${added[Number(m[1])].i}.${m[2]}`, fe!.message) : res;
    }
  }
  for (const { i, l, v } of kept) {
    const res = await saveEdit(
      ctx,
      {
        status: l.o.status,
        dispatchOn: h.dispatchOn ?? "",
        delivery: text(h.delivery) ?? l.delivery.name,
        transporter: h.transporter ?? "",
        qty: v.qty ?? "",
        rate: v.rate ?? rupeesField(l.o.ratePaise),
        discount: v.discount ?? (l.o.discountBp == null ? "" : String(l.o.discountBp / 100)),
        transport: rupeesField(l.o.transportCostPaise),
        remark: v.remark ?? "",
      },
      l.o.id,
    );
    if (!res.ok) {
      const fe = res.fieldErrors?.[0];
      return fe ? fieldErr(`l${i}.${fe.field}`, fe.message) : res;
    }
  }
  for (const l of [...removed, ...replaced]) {
    await db.delete(erpOrders).where(eq(erpOrders.id, l.o.id));
    await erpAudit(ctx, "erp.order.delete", "erp_order", l.o.id, l.o, null);
    await reopenOrderCheck(ctx, l.o.orderNo, `${l.sku.name} removed`);
  }
  if (removed.length || replaced.length) await syncBookOrders([one.o.orderNo]);
  const n = (k: number, w: string) => (k ? `${k} ${w}` : "");
  const said = [n(kept.length, "kept"), n(added.length - replaced.length, "added"), n(replaced.length, "SKU changed"), n(removed.length, "removed")].filter(Boolean).join(" · ");
  return okVoid(`Order ${one.o.orderNo} saved${said ? ` — ${said}` : ""}`);
}

async function allocateForm(ctx: ErpContext, id: string): Promise<FormSpec | null> {
  const [l] = await orderLines({ ids: [id] });
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

/**
 * EVERY ORDER-LINE COLUMN, said once. The Orders tabs and Billing & dispatch
 * each typed their own list, and one key had drifted into three headings
 * ("Transporter" / "Transport name", "Qty" / "Order qty", "Labels" / "No of
 * label"). A tab picks the keys it draws; the heading, kind and power are
 * the column's own.
 */
const ORDER_COL: Record<string, Col> = {
  orderId: { k: "orderId", l: "Order id", t: "mono" },
  orderNo: { k: "orderNo", l: "Order no", t: "mono" },
  date: { k: "date", l: "Order date", t: "d" },
  source: { k: "source", l: "Received by", t: "t" },
  status: { k: "status", l: "Status", t: "s" },
  orderStatus: { k: "orderStatus", l: "Order", t: "s" },
  production: { k: "production", l: "Production", t: "s" },
  billingStatus: { k: "billingStatus", l: "Billing", t: "s" },
  dispatchStatus: { k: "dispatchStatus", l: "Dispatch", t: "s" },
  logistics: { k: "logistics", l: "Logistics", t: "s" },
  billing: { k: "billing", l: "Billing party", t: "b" },
  delivery: { k: "delivery", l: "Delivery party", t: "t" },
  sku: { k: "sku", l: "Description of goods", t: "t", w: 240 },
  qty: { k: "qty", l: "Order qty", t: "n" },
  boxes: { k: "boxes", l: "Boxes", t: "n" },
  rate: { k: "rate", l: "Rate", t: "m", pw: "viewSalesRate" },
  discount: { k: "discount", l: "Discount %", t: "n", pw: "viewSalesAmounts" },
  alloc: { k: "alloc", l: "Allocation", t: "s" },
  entry: { k: "entry", l: "Entry", t: "s" },
  bill: { k: "bill", l: "Tally invoice no", t: "mono" },
  invoiceDate: { k: "invoiceDate", l: "Invoice date", t: "d" },
  transporter: { k: "transporter", l: "Transporter", t: "t" },
  area: { k: "area", l: "Area", t: "t" },
  city: { k: "city", l: "City", t: "t" },
  labels: { k: "labels", l: "Stickers", t: "n" },
  type: { k: "type", l: "Type", t: "s" },
  remark: { k: "remark", l: "Remark", t: "t" },
  /* What the LINE weighs (`lineWeightKg`), never one box's — the figure a
     lorry is booked by, so it sits beside the boxes it is counted from. */
  weight: { k: "weight", l: "Weight", t: "n", u: " kg" },
  godown: { k: "godown", l: "Godown", t: "t" },
  f: { k: "f", l: "Flags", t: "f" },
};

const orderCol = (k: keyof typeof ORDER_COL, over: Partial<Col> = {}): Col => ({ ...ORDER_COL[k], ...over });
const orderCols = (keys: (keyof typeof ORDER_COL)[], over: Partial<Record<string, Partial<Col>>> = {}): Col[] => keys.map((k) => orderCol(k, over[k]));

/**
 * THE ORDERS TABS, one step of the PRD's flow each:
 *   verifyOrders   orders awaiting the back office's verification (step 2)
 *   readyOrders    under production and Ready (steps 3–4)
 *   toBill         Ready material awaiting billing (step 5)
 *   invoiceCheck   invoices awaiting the independent check, or rejected (step 6)
 *   labels         approved invoices whose dispatch stickers are due (step 7)
 *   pendingOrders  what the office is holding
 *   orders         the register: every line
 */
type Scope = "orders" | "pendingOrders" | "readyOrders" | "labels" | "verifyOrders" | "toBill" | "invoiceCheck";

/**
 * The two lists' own rules, said ONCE: the Pending and Ready tabs, their
 * sidebar badges and the dashboard all read these, so a badge cannot count a
 * different set from the list it opens.
 */
export function isPendingLine(l: OrderLine, detailedOrders: Set<number>): boolean {
  /* Neither Under Process nor Ready: those two are the Under process & ready
     tab's (`isWorkingLine`), and a line belongs to ONE tab. Mahek Plus's
     Pending view had no status test, so every line sat there from entry to
     billing and the same line was on two tabs at once; leaving out only Ready
     kept every Under Process line on both. What is left is what the office is
     holding — Hold From Office, or a status nobody has worked yet. */
  return (
    l.o.status !== "Cancel" &&
    l.o.status !== "Ready" &&
    l.o.status !== "Under Process" &&
    l.sku.name !== "Empty Drum" &&
    !detailedOrders.has(l.o.orderNo)
  );
}

/** Being worked on: Ready or Under Process, and not yet done. Also the Labels tab's rows. */
export function isWorkingLine(l: OrderLine): boolean {
  return (l.o.status === "Ready" || l.o.status === "Under Process") && l.o.entryStatus !== "Done";
}

/** Awaiting the back office: not cancelled, not billed, and its order not verified. */
export function isToVerifyLine(l: OrderLine): boolean {
  return l.o.status !== "Cancel" && !l.inDetails && l.o.orderCheck !== "Verified";
}

/** Ready material awaiting billing: Ready, the order verified, not yet billed. */
export function isToBillLine(l: OrderLine): boolean {
  return l.o.status === "Ready" && l.o.orderCheck === "Verified" && !l.inDetails;
}

/** An invoice for the checker: billed, not yet approved, not gone. */
export function isInvoiceToCheckLine(l: OrderLine): boolean {
  return l.inDetails && !l.dispatched && l.o.status !== "Cancel" && l.invoiceCheck !== "Approved";
}

/**
 * Dispatch stickers due: every line being made or ready, billed or not, until
 * it leaves. It used to wait for the invoice check's approval, and Mahek
 * stickers the boxes while they are still on the floor — so the tab stood
 * empty while the godown stickered by hand. The check stays, optional: a
 * pending one holds nothing here. A billed line counts whatever its status
 * now says; an old sheet line finished outside the ERP (entry Done, never
 * billed here) does not.
 */
export function isStickerLine(l: OrderLine): boolean {
  return l.o.status !== "Cancel" && !l.dispatched && (isWorkingLine(l) || l.inDetails);
}

function inScope(scope: Scope, l: OrderLine, detailedOrders: Set<number>): boolean {
  if (scope === "orders") return true;
  if (scope === "pendingOrders") return isPendingLine(l, detailedOrders);
  if (scope === "verifyOrders") return isToVerifyLine(l);
  if (scope === "toBill") return isToBillLine(l);
  if (scope === "invoiceCheck") return isInvoiceToCheckLine(l);
  if (scope === "labels") return isStickerLine(l);
  return isWorkingLine(l);
}

/** The orders list is the register: every line, read by order date. The other three are open work. */
const ORDERS_WINDOW = { label: "Order date", default: "month" } as const;

/**
 * The lines a list draws, read in SQL: the register through its window, a
 * working list as open work, and "Show the whole order" (ids) as exactly those.
 * Null where the window holds more than one load may build.
 */
async function listLines(scope: Scope, s: LoadScope | undefined): Promise<{ lines: OrderLine[]; wide: { n: number; cap: number } | null }> {
  if (s?.ids?.length) return { lines: await orderLines({ ids: s.ids }), wide: null };
  if (scope !== "orders") return { lines: await orderLines({ openWork: true }), wide: null };
  const f: LineFilter = { window: { scope: s ?? unscoped(), on: "order" } };
  const wide = tooWide(await countLines(f), f.window!.scope);
  return { lines: wide ? [] : await orderLines(f), wide };
}

const NO_DATA: Record<Scope, string> = {
  orders: "No sales orders yet.",
  pendingOrders: "Nothing on hold. Every open line is Under Process, Ready or billed.",
  readyOrders: "Nothing under process or ready.",
  verifyOrders: "Every order has been verified by the back office.",
  toBill: "No Ready material waiting for its bill.",
  invoiceCheck: "No invoice waiting for its check.",
  labels: "Nothing under process or ready is waiting for its dispatch stickers.",
};

/** The invoice prompt, asked when an order is billed and when its invoice is changed. */
function invoicePrompt(title: string, sub: string, init: Record<string, string>): NonNullable<ActionSpec["prompt"]> {
  return {
    title,
    sub,
    submit: "Save",
    fields: [
      { k: "invoiceNo", l: "Tally invoice no.", t: "text", req: true },
      { k: "invoiceDate", l: "Invoice date", t: "date", req: true },
    ],
    init,
  };
}

const CORRECTION_PROMPT = (what: string): NonNullable<ActionSpec["prompt"]> => ({
  title: `Send ${what} back for correction`,
  submit: "Send back",
  fields: [{ k: "reason", l: "What needs correcting", t: "area", req: true, mic: true }],
});

function orderList(scope: Scope): ScreenModule {
  return {
    key: scope,
    ...(scope === "orders" ? { window: ORDERS_WINDOW } : {}),
    async load(ctx, s) {
      const { lines, wide } = await listLines(scope, s);
      const detailedOrders = detailedOrdersOf(lines);
      const shown = lines.filter((l) => inScope(scope, l, detailedOrders));
      const labels = scope === "labels";
      const checking = scope === "invoiceCheck";
      const DOMAINS = ["orderStatus", "production", "billingStatus", "dispatchStatus"] as const;
      const all: Col[] = labels
        ? orderCols(["orderNo", "date", "billing", "delivery", "sku", "qty", "weight", "bill", "invoiceDate", "type", "labels", "transporter", "area", "godown", "f"], { billing: { t: "t" }, delivery: { t: "b" } })
        : checking
          ? orderCols(["orderNo", "date", "billing", "delivery", "sku", "qty", "weight", "rate", "discount", "bill", "invoiceDate", "billingStatus", "godown", "f"])
          : orderCols([
              "orderNo",
              "date",
              ...DOMAINS,
              ...(scope === "orders" ? (["logistics"] as const) : []),
              "billing",
              "delivery",
              "sku",
              "qty",
              "boxes",
              "weight",
              "rate",
              "discount",
              "alloc",
              "bill",
              "source",
              "transporter",
              /* The delivery party's city, named in each order's group heading
                 below — a heading only draws a column the list carries. */
              "city",
              "labels",
              "godown",
              "f",
            ]);
      const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
      /* A Pending customer's order is approved in the ERP only while the ERP
         is not live; once it is, the Accounts queue decides it. */
      const approver = ctx.powers.has("approveParty") && !(await erpOrdersLive());
      const verifier = ctx.powers.has("verifyOrders");
      const checker = ctx.powers.has("checkInvoices");
      const bulk: BulkSpec[] =
        labels || checking
          ? []
          : [
              ...(verifier && (scope === "verifyOrders" || scope === "orders") ? [{ id: "verifyOrder", l: "Verify order" }] : []),
              ...(verifier && scope === "orders" ? [{ id: "unverifyOrder", l: "Undo verification" }] : []),
              { id: "ready", l: "Ready" },
              { id: "underProcess", l: "Under Process" },
              { id: "hold", l: "Hold From Office" },
              /* Which of the selection can be cancelled, and what the order book does with it. */
              { id: "cancel", l: "Cancel", impact: { kind: "erp-order-cancel" } },
              ...(approver ? [{ id: "approve", l: "Approved By Admin" }] : []),
            ];
      const byNo = new Map<number, OrderLine[]>();
      /* An order is billed, checked and dispatched WHOLE, so its blockers are read off every line of it — not only the ones this tab draws. */
      const orderNos = [...new Set(shown.map((l) => l.o.orderNo))];
      const whole = orderNos.length ? await orderLines({ orderNos }) : [];
      whole.forEach((l) => byNo.set(l.o.orderNo, [...(byNo.get(l.o.orderNo) ?? []), l]));
      const continued = new Map<number, number[]>();
      if (orderNos.length) {
        const rows = (await db.execute(sql`select distinct order_no as n, linked_from_order_no as f from erp_orders where linked_from_order_no in ${orderNos}`)) as unknown as { n: number; f: number }[];
        for (const r of rows) continued.set(Number(r.f), [...(continued.get(Number(r.f)) ?? []), Number(r.n)]);
      }
      const [prices, reviews, gates] = await Promise.all([
        /* Read for the lines drawn, not inside orderLines: the badges and the dashboard count lines and never price them. */
        priceBook(shown.map((l) => l.billing.id)),
        reviewsFor(orderNos),
        scanGateFor(db, shown.filter((l) => l.inDetails && !l.dispatched).map((l) => l.o.id)),
      ]);
      return {
        spec: {
          screen: scope,
          cols,
          hidden,
          groups: labels ? ["transporter"] : ["orderNo"],
          groupHead: labels ? undefined : ["date", "billing", "delivery", "transporter", "city", "godown"],
          groupHeadStrong: ["delivery", "transporter", "city"],
          groupHeadUnlessSame: { delivery: "billing" },
          groupSel: !labels,
          /* An order's weight, or a transporter's on the Stickers tab — what
             the lorry is booked by. A line whose SKU has no weight in the
             catalogue is counted and said, or the total reads as the whole. */
          agg: [
            { k: "labels", l: "stickers" },
            { k: "weight", l: "kg", missing: "without a weight" },
          ],
          godownKey: "godown",
          sortDefault: labels ? ["sku", 1] : undefined,
          bulk: bulk.length ? bulk : undefined,
          ...(labels || checking ? {} : await newFormIn(s, () => orderForm(ctx))),
          newLabel: "New order",
          noDataLine: NO_DATA[scope],
        },
        tooWide: wide,
        rows: shown.map((l): ListRow => {
          const order = byNo.get(l.o.orderNo) ?? [l];
          const live = order.filter((x) => x.o.status !== "Cancel");
          const billed = live.some((x) => x.inDetails);
          const dispatched = live.some((x) => x.dispatched);
          const blockers = billBlockersFor(order);
          const d = lineDomains(l, gates.get(l.o.id) ?? null);
          const ownBill = live.some((x) => x.inDetails && x.billedById === ctx.user.id);
          const printable = isStickerLine(l);
          const actions: ActionSpec[] = labels
            ? [
                { id: "labels", l: `Print dispatch stickers · order ${l.o.orderNo}`, primary: true, href: erpLabelsHref({ order: l.o.orderNo }) },
                { id: "stickers", l: "Stickers are on", why: l.stickersAt ? "Already recorded" : "" },
              ]
            : [
                /* First, so it earns a footer button rather than a place under More: the whole order, in one modal. */
                { id: "editOrder", l: "Edit order", loadsForm: true, why: l.o.status === "Cancel" ? "This line is cancelled" : "" },
                ...(verifier && !billed && l.o.status !== "Cancel"
                  ? [
                      l.o.orderCheck === "Verified"
                        ? ({ id: "unverifyOrder", l: "Undo verification", confirm: `Take back the verification of order ${l.o.orderNo} — ${l.billing.name}? It goes back to To verify, and cannot be billed until it is verified again.` } as ActionSpec)
                        : ({ id: "verifyOrder", l: "Verify order", primary: true, confirm: `Verify order ${l.o.orderNo} — ${l.billing.name}, ${live.length} line${live.length === 1 ? "" : "s"} — against what the customer asked for?` } as ActionSpec),
                      { id: "correctOrder", l: "Send back for correction", why: l.o.orderCheck === "Correction" ? "Already sent back" : "", prompt: CORRECTION_PROMPT(`order ${l.o.orderNo}`) } as ActionSpec,
                    ]
                  : []),
                ...statusActions(l),
                ...(billed
                  ? [
                      { id: "unbill", l: "Undo billing", why: dispatched ? "It has been dispatch-verified" : "", impact: { kind: "erp-order-unbill", id: l.o.id } } as ActionSpec,
                      {
                        id: "changeInvoice",
                        l: "Change invoice",
                        why: dispatched ? "It has been dispatch-verified" : "",
                        prompt: invoicePrompt(`Change the invoice · order ${l.o.orderNo}`, "An approved invoice goes back to the checker.", { invoiceNo: l.o.tallyBillNo ?? "", invoiceDate: l.o.invoiceDate ?? today() }),
                      } as ActionSpec,
                    ]
                  : [
                      {
                        id: "bill",
                        l: "Bill it",
                        primary: !blockers.length,
                        why: blockers.length ? `Needs ${blockers.join("; ")}` : "",
                        prompt: invoicePrompt(
                          `Bill order ${l.o.orderNo}`,
                          `Enter the invoice made in Tally for the whole order — ${live.length} line${live.length === 1 ? "" : "s"}. The invoice check is optional; only a rejected invoice holds dispatch.`,
                          { invoiceNo: l.o.tallyBillNo ?? "", invoiceDate: today() },
                        ),
                      } as ActionSpec,
                    ]),
                ...(checker && l.inDetails && !l.dispatched
                  ? [
                      {
                        id: "approveInvoice",
                        l: "Approve invoice",
                        primary: checking && l.invoiceCheck !== "Approved",
                        why: l.invoiceCheck === "Approved" ? "Already approved" : ownBill && !ctx.administrator ? "You entered this bill; somebody else checks it" : "",
                        confirm: `Approve invoice ${l.o.tallyBillNo ?? ""} for order ${l.o.orderNo}? You have checked the customer, goods, quantities, rate and discount against the order.`,
                      } as ActionSpec,
                      {
                        id: "rejectInvoice",
                        l: "Reject invoice",
                        why: l.invoiceCheck === "Rejected" ? "Already rejected" : ownBill && !ctx.administrator ? "You entered this bill; somebody else checks it" : "",
                        prompt: { title: `Reject invoice · order ${l.o.orderNo}`, submit: "Reject", fields: [{ k: "reason", l: "Reason", t: "area", req: true, mic: true }] },
                      } as ActionSpec,
                    ]
                  : []),
                ...(approver && l.o.partyStatus === "Pending" ? [{ id: "approve", l: "Approved By Admin" } as ActionSpec] : []),
                { id: "edit", l: "Edit this line", loadsForm: true },
                { id: "more", l: "Add another", loadsForm: true, why: billed ? "The order is billed; one order is one bill" : "" },
                ...(!l.inDetails && l.o.status !== "Cancel"
                  ? [
                      {
                        id: "moveOut",
                        l: "Move to a new order",
                        why: l.allocations ? "Release its batch codes first" : "",
                        prompt: {
                          title: `Move to a new order · ${l.sku.name}`,
                          sub: `For goods that will go later. The cans moved get a new order number linked to order ${l.o.orderNo}.`,
                          submit: "Move",
                          fields: [{ k: "qty", l: "Cans to move", t: "num", req: true, min: 1 }],
                          init: { qty: String(l.o.qtyCans) },
                        },
                      } as ActionSpec,
                    ]
                  : []),
                { id: "select", l: "Show the whole order", href: erpLink(scope, { f: order.map((x) => x.o.id).join(","), fl: `Order ${l.o.orderNo}` }) },
                { id: "customer", l: "View customer", href: erpLink("customers", { open: l.billing.id }) },
                ...(l.o.status === "Ready" && !l.dispatched ? [{ id: "scan", l: "Scan boxes at dispatch", href: erpDispatchHref(l.o.orderNo) } as ActionSpec] : []),
                ...(l.o.status !== "Cancel" ? [{ id: "labels", l: "Print dispatch stickers", href: printable ? erpLabelsHref({ order: l.o.orderNo }) : undefined, why: printable ? "" : l.dispatched ? "It has left" : "Once it is under process or ready" } as ActionSpec] : []),
                { id: "trace", l: "Trace this order", href: erpTraceHref(orderTraceCode(l.o.orderNo)) },
                {
                  id: "delete",
                  l: "Delete",
                  why: l.inDetails ? "It is billed" : l.allocations ? "Release its batch codes first" : "",
                  /* The order book, the back office's check and the floor's loading job move with it. */
                  impact: { kind: "erp-order-line", id: l.o.id },
                },
              ];
          const history = (reviews.get(l.o.orderNo) ?? []).slice(0, 6);
          const next = continued.get(l.o.orderNo) ?? [];
          return {
            id: l.o.id,
            v: withoutHidden(
              {
                orderId: l.o.id,
                orderNo: String(l.o.orderNo),
                date: l.o.orderDate,
                source: l.o.orderSource,
                status: l.o.status,
                orderStatus: d.order,
                production: d.production,
                billingStatus: d.billing,
                dispatchStatus: d.dispatch,
                logistics: d.logistics,
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
                invoiceDate: l.o.invoiceDate,
                transporter: l.o.transporter ?? l.delivery.p?.transporter ?? "—",
                labels: l.labels,
                type: l.type,
                remark: l.o.remark,
                area: l.delivery.area,
                city: l.delivery.city,
                weight: l.weightKg,
                godown: l.godown,
              },
              hiddenKeys,
            ),
            flags: lineFlags(l),
            title: l.delivery.name,
            header: [l.due ? DUE_WORD[l.due] : "", l.si.replace(/( - )+$/, "") || `${l.sku.name} · ${nf(l.o.qtyCans)} cans`].filter(Boolean).join(" · "),
            fields: [
              { l: "Order", v: d.order, der: true },
              { l: "Production", v: d.production ?? "—", der: true },
              { l: "Billing", v: d.billing ?? "—", der: true },
              { l: "Dispatch", v: d.dispatch ?? "—", der: true },
              ...(d.logistics ? [{ l: "Logistics", v: d.logistics, der: true }] : []),
              { l: "Order received by", v: l.o.orderSource ?? "Not recorded" },
              { l: "Order verified", v: l.o.orderCheck === "Verified" ? (l.o.orderCheckedAt ? `Yes · ${stamp(l.o.orderCheckedAt)}` : "Yes (before verification was asked)") : l.o.orderCheck === "Correction" ? `Sent back — ${l.o.orderCheckNote ?? ""}` : "Not yet" },
              ...(l.inDetails
                ? [
                    { l: "Tally invoice", v: `${l.o.tallyBillNo ?? "—"}${l.o.invoiceDate ? ` · ${fd(l.o.invoiceDate)}` : ""}` },
                    {
                      l: "Invoice check",
                      v:
                        l.invoiceCheck === "Approved"
                          ? l.invoiceCheckedAt
                            ? `Approved · ${stamp(l.invoiceCheckedAt)}`
                            : "Approved (before the check was asked)"
                          : l.invoiceCheck === "Rejected"
                            ? `Rejected — ${l.invoiceCheckNote ?? ""}`
                            : "Waiting for the checker",
                    },
                    { l: "Dispatch stickers", v: l.stickersAt ? `On · ${stamp(l.stickersAt)}` : "Not recorded" },
                  ]
                : []),
              ...(l.o.linkedFromOrderNo ? [{ l: "Moved out of", v: `Order ${l.o.linkedFromOrderNo}` }] : []),
              ...(next.length ? [{ l: "Continued on", v: next.map((n) => `Order ${n}`).join(", ") }] : []),
              { l: "Dispatch on", v: l.o.dispatchOn ? fd(l.o.dispatchOn) : "Not planned" },
              { l: "Standing instructions", v: l.si || "—", der: true },
              { l: "Area", v: l.delivery.area ?? "—", der: true },
              { l: "Type", v: l.type, der: true },
              { l: "Allocated", v: `${nf(l.allocated)} of ${nf(allocationTarget(l.boxed, l.boxes, l.o.qtyCans))} ${l.boxed ? "boxes" : "cans"} · ${l.allocations} batch code${l.allocations === 1 ? "" : "s"}`, der: true },
              { l: "Weight", v: l.weightKg == null ? "—" : `${nf(l.weightKg)} kg`, der: true },
              { l: "Price list", v: prices.listOf(l.billing.id)?.name ?? "None applies to the billing party", der: true },
              ...(ctx.powers.has("viewSalesRate") ? [{ l: "Rate 2 (live price list)", v: inr(prices.rateOf(l.billing.id, l.sku)) || "—", der: true }] : []),
              { l: "Freight charged to the customer", v: inr(l.o.transportCostPaise) },
              { l: "Party status", v: l.o.partyStatus ?? "—" },
              { l: "Remark / customer instructions", v: l.o.remark || "—" },
              ...(history.length ? [{ l: "Check history", v: history.map(reviewLine).join("\n"), der: true }] : []),
            ],
            actions,
            by: stampLine(l.by, l.o.createdAt),
          };
        }),
      };
    },
    ...lineHandlers(scope),
  };
}

/* ============================================================ handlers */

async function lines(ids: string[]): Promise<OrderLine[]> {
  const set = new Set(ids);
  return (await orderLines({ ids })).filter((l) => set.has(l.o.id));
}

async function setMany(ctx: ErpContext, ids: string[], values: Partial<typeof erpOrders.$inferInsert>, action: string, msg: (n: number) => string): Promise<Result<unknown>> {
  if (!ids.length) return err("Nothing selected.");
  await db.update(erpOrders).set({ ...values, updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpOrders.id, ids));
  await erpAudit(ctx, action, "erp_order", ids.join(","), null, values);
  await syncBookOrders(await orderNosOf(ids));
  return okVoid(msg(ids.length));
}

const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

/** Where a line's stock is counted: packed boxes for a boxed SKU, filled cans for a loose one. */
const stockKey = (l: OrderLine) => `${l.boxed ? "pack" : "fg"}|${l.sku.id}|${l.o.godownId}`;
const stillToAllocate = (l: OrderLine) => Math.max(0, allocationTarget(l.boxed, l.boxes, l.o.qtyCans) - l.allocated);

/**
 * READY IS REFUSED WITHOUT STOCK. A line is Ready only where its godown holds
 * the boxes (or cans) it needs, after what the lines already Ready and not yet
 * allocated will take — `readyStockCheck` is the rule. The lines that pass are
 * marked; each that fails is named with what it needs against what is there.
 */
/** The lines among these that the shelf cannot cover, each with the sentence that says so. */
async function stockShortfalls(asked: { l: OrderLine; need: number }[]): Promise<Map<string, string>> {
  /* What the lines already Ready will take: open work, by definition. */
  const all = await orderLines({ openWork: true });
  const onShelf = await fgLevelAvailable();
  const free = new Map(asked.map(({ l }) => [stockKey(l), onShelf(l.sku.id, l.boxed, l.o.godownId)]));
  const askedIds = new Set(asked.map(({ l }) => l.o.id));
  const reserved = new Map<string, number>();
  for (const l of all) if (l.o.status === "Ready" && !l.dispatched && !askedIds.has(l.o.id)) reserved.set(stockKey(l), (reserved.get(stockKey(l)) ?? 0) + stillToAllocate(l));
  const byId = new Map(asked.map(({ l }) => [l.o.id, l]));
  const out = new Map<string, string>();
  for (const a of readyStockCheck(asked.map(({ l, need }) => ({ id: l.o.id, key: stockKey(l), need })), free, reserved)) {
    if (a.ok) continue;
    const l = byId.get(a.id)!;
    out.set(a.id, `order ${l.o.orderNo} · ${l.sku.name} at ${l.godown} needs ${nf(a.need)} ${l.boxed ? "boxes" : "cans"}, ${nf(a.free)} in stock`);
  }
  return out;
}

async function doReady(ctx: ErpContext, ids: string[]) {
  const asked = (await lines(ids)).filter((l) => l.o.status !== "Ready");
  if (!asked.length) return err("Those lines are already Ready.", "rule_violation");
  /* PRD step 3: production starts on a VERIFIED order, so Ready waits for the back office. */
  const unverified = asked.filter((l) => l.o.orderCheck !== "Verified");
  const checkable = asked.filter((l) => l.o.orderCheck === "Verified");
  const notVerified = [...new Set(unverified.map((l) => l.o.orderNo))].map((n) => `order ${n} is not verified by the back office yet`);
  if (!checkable.length) return err(`Not marked Ready: ${notVerified.join("; ")}.`, "rule_violation");
  const short = await stockShortfalls(checkable.map((l) => ({ l, need: stillToAllocate(l) })));
  const ok = checkable.filter((l) => !short.has(l.o.id)).map((l) => l.o.id);
  const why = [...[...short.values()].map((x) => `stock is not there: ${x}`), ...notVerified].join("; ");
  if (!ok.length) return err(`Not marked Ready: ${why}. Pack or move the stock first, then mark it Ready.`, "rule_violation");
  const res = await setMany(ctx, ok, { status: "Ready" }, "erp.order.ready", (n) => `Marked Ready · ${plural(n)}`);
  if (res.ok) await tellReadyToBill(ok);
  if (res.ok && why) return okVoid(`Marked Ready · ${plural(ok.length)}. Not marked — ${why}.`);
  return res;
}

/** PRD step 4: once every live line of an order is Ready, the back office is told its bill can be made. */
async function tellReadyToBill(ids: string[]) {
  const nos = await orderNosOf(ids);
  const whole = await orderLines({ orderNos: nos });
  const ready: OrderLine[] = [];
  for (const n of nos) {
    const live = whole.filter((l) => l.o.orderNo === n && l.o.status !== "Cancel");
    if (live.length && live.every((l) => l.o.status === "Ready" && !l.inDetails)) ready.push(live[0]);
  }
  if (!ready.length) return;
  const to = await holdersOf("verifyOrders");
  for (const l of ready) await tell(to, `Ready to bill · order ${l.o.orderNo}`, `${l.billing.name}: the material is Ready. Make the bill in Tally and record its number.`, erpLink("toBill", {}));
}

/**
 * A STATUS MOVES EITHER WAY. Any line not yet dispatch-verified can be put at
 * any status, back as well as forward — the edit form always allowed it, and
 * the row and bulk actions now offer the same. Two checks stay because they
 * protect stock, not the order of steps: Ready needs the stock on the shelf
 * (`doReady`), and Cancel needs the line unbilled and its batch codes released,
 * since an allocated lot is counted out of stock until it is let go. Ready also
 * needs the order verified by the back office (PRD step 3).
 */
const STATUS_ACTION: Record<string, string> = { "Under Process": "underProcess", "Hold From Office": "hold", Cancel: "cancel" };
function statusActions(l: OrderLine): ActionSpec[] {
  const out: ActionSpec[] = [];
  if (l.o.status !== "Ready")
    out.push({
      id: "ready",
      l: "Ready",
      primary: l.o.status !== "Cancel" && l.o.orderCheck === "Verified",
      why: l.dispatched ? "It has been dispatch-verified" : l.o.orderCheck !== "Verified" ? "The back office has not verified the order yet" : "",
    });
  for (const st of ["Under Process", "Hold From Office", "Cancel"]) {
    if (l.o.status === st) continue;
    const why = l.dispatched
      ? "It has been dispatch-verified"
      : st === "Cancel" && l.inDetails
        ? "It is billed; undo billing first"
        : st === "Cancel" && l.allocations
          ? "Release its batch codes first"
          : "";
    out.push({ id: STATUS_ACTION[st], l: st, why, impact: st === "Cancel" ? { kind: "erp-order-cancel", id: l.o.id } : undefined } as ActionSpec);
  }
  return out;
}
async function doStatus(ctx: ErpContext, ids: string[], status: string) {
  const ls = (await lines(ids)).filter((l) => l.o.status !== status);
  if (!ls.length) return err(`Those lines are already ${status}.`, "rule_violation");
  const refused: string[] = [];
  const ok: string[] = [];
  for (const l of ls) {
    const why = l.dispatched
      ? "dispatch-verified"
      : status === "Cancel" && l.inDetails
        ? "billed — undo billing first"
        : status === "Cancel" && l.allocations
          ? "has batch codes — release them first"
          : "";
    if (why) refused.push(`order ${l.o.orderNo} · ${l.sku.name} is ${why}`);
    else ok.push(l.o.id);
  }
  if (!ok.length) return err(`Not changed: ${refused.join("; ")}.`, "rule_violation");
  const action = `erp.order.${STATUS_ACTION[status] ?? "status"}`;
  const res = await setMany(ctx, ok, { status }, action, (n) => `${plural(n)} ${status}`);
  if (res.ok && refused.length) return okVoid(`${plural(ok.length)} ${status}. Not changed: ${refused.join("; ")}.`);
  return res;
}
const doUnder = (ctx: ErpContext, ids: string[]) => doStatus(ctx, ids, "Under Process");
/**
 * "Approved By Admin", the ERP's own check on a Pending customer — used only
 * while the ERP is not where orders are taken. With `erp.orders.live` on, the
 * order is in the Accounts approval queue instead and the answer arrives
 * through `afterBookDecision`; a second door here would be two approvals.
 */
async function doApprove(ctx: ErpContext, ids: string[]) {
  if (await erpOrdersLive()) return err("Accounts approve a new customer's order now, from their approval queue.", "rule_violation");
  if (!ctx.powers.has("approveParty")) return err("Only an admin or the office approves a pending party's order.", "not_permitted");
  return setMany(ctx, ids, { partyStatus: "Approved By Admin" }, "erp.order.approveParty", (n) => `${plural(n)} approved`);
}

/** Every line of the orders these lines belong to — the unit the PRD's checks, bill and dispatch work on. */
async function wholeOrders(ids: string[]): Promise<Map<number, OrderLine[]>> {
  const nos = await orderNosOf(ids);
  const out = new Map<number, OrderLine[]>();
  for (const l of await orderLines({ orderNos: nos })) out.set(l.o.orderNo, [...(out.get(l.o.orderNo) ?? []), l]);
  return out;
}

/* --------------------------------------------- step 2: the back office's check */

async function doVerifyOrder(ctx: ErpContext, ids: string[]) {
  if (!ctx.powers.has("verifyOrders")) return err("The back office verifies orders: it needs the Verify orders power.", "not_permitted");
  const orders = await wholeOrders(ids);
  const done: number[] = [];
  const refused: string[] = [];
  for (const [no, order] of orders) {
    const live = order.filter((l) => l.o.status !== "Cancel");
    if (!live.length) refused.push(`order ${no} is cancelled`);
    else if (live.some((l) => l.inDetails)) refused.push(`order ${no} is already billed`);
    else if (live.every((l) => l.o.orderCheck === "Verified")) refused.push(`order ${no} is already verified`);
    else {
      await db.transaction(async (tx) => {
        await tx
          .update(erpOrders)
          .set({ orderCheck: "Verified", orderCheckedById: ctx.user.id, orderCheckedAt: new Date(), orderCheckNote: null, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(inArray(erpOrders.id, live.map((l) => l.o.id)));
        await addReview(tx, ctx, no, "order", "verified", null, {
          billing: live[0].billing.name,
          delivery: live[0].delivery.name,
          lines: live.map((l) => ({ sku: l.sku.name, qty: l.o.qtyCans, rate: l.o.ratePaise, discount: l.o.discountBp })),
        });
      });
      await erpAudit(ctx, "erp.order.verify", "erp_order", String(no), { orderCheck: live[0].o.orderCheck }, { orderCheck: "Verified" });
      done.push(no);
    }
  }
  if (!done.length) return err(`Not verified: ${refused.join("; ")}.`, "rule_violation");
  return okVoid(`Verified · order${done.length === 1 ? "" : "s"} ${done.join(", ")}${refused.length ? `. Not verified: ${refused.join("; ")}` : ""}`);
}

/** A verification given by mistake is taken back: Pending again, back on To verify, and the history says who undid it. Billed is the invoice checker's. */
async function doUnverifyOrder(ctx: ErpContext, ids: string[]) {
  if (!ctx.powers.has("verifyOrders")) return err("The back office verifies orders: it needs the Verify orders power.", "not_permitted");
  const orders = await wholeOrders(ids);
  const done: number[] = [];
  const refused: string[] = [];
  for (const [no, order] of orders) {
    const live = order.filter((l) => l.o.status !== "Cancel");
    if (!live.length) refused.push(`order ${no} is cancelled`);
    else if (live.some((l) => l.inDetails)) refused.push(`order ${no} is billed; undo the billing first`);
    else if (!live.some((l) => l.o.orderCheck === "Verified")) refused.push(`order ${no} is not verified`);
    else {
      await db.transaction(async (tx) => {
        await tx
          .update(erpOrders)
          .set({ orderCheck: "Pending", orderCheckedById: null, orderCheckedAt: null, orderCheckNote: null, updatedAt: new Date(), updatedById: ctx.user.id })
          .where(inArray(erpOrders.id, live.map((l) => l.o.id)));
        await addReview(tx, ctx, no, "order", "reset", "Verification undone");
      });
      await erpAudit(ctx, "erp.order.unverify", "erp_order", String(no), { orderCheck: "Verified" }, { orderCheck: "Pending" });
      done.push(no);
    }
  }
  if (!done.length) return err(`Not undone: ${refused.join("; ")}.`, "rule_violation");
  return okVoid(`Back on To verify · order${done.length === 1 ? "" : "s"} ${done.join(", ")}${refused.length ? `. Not undone: ${refused.join("; ")}` : ""}`);
}

async function doCorrectOrder(ctx: ErpContext, id: string, values: Record<string, string>) {
  if (!ctx.powers.has("verifyOrders")) return err("The back office verifies orders: it needs the Verify orders power.", "not_permitted");
  const reason = text(values.reason);
  if (!reason) return fieldErr("reason", "Say what needs correcting");
  const [order] = [...(await wholeOrders([id])).values()];
  const live = (order ?? []).filter((l) => l.o.status !== "Cancel");
  if (!live.length) return err("That order has no live lines.", "not_found");
  if (live.some((l) => l.inDetails)) return err("The order is billed; the invoice checker sends it back now.", "rule_violation");
  const no = live[0].o.orderNo;
  await db.transaction(async (tx) => {
    await tx
      .update(erpOrders)
      .set({ orderCheck: "Correction", orderCheckedById: ctx.user.id, orderCheckedAt: new Date(), orderCheckNote: reason, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpOrders.id, live.map((l) => l.o.id)));
    await addReview(tx, ctx, no, "order", "correction", reason);
  });
  await erpAudit(ctx, "erp.order.correction", "erp_order", String(no), null, { reason });
  await tell([live[0].o.createdById], `Order ${no} needs correcting`, `${live[0].billing.name}: ${reason}`, erpLink("verifyOrders", {}), "warn");
  return okVoid(`Order ${no} sent back for correction`);
}

/* ---------------------------------------------------- step 5: the bill */

async function invoiceTakenBy(no: number, key: string): Promise<number | null> {
  const [hit] = (await db.execute(sql`
    select o.order_no as n from erp_orders o
     where o.order_no <> ${no} and o.status <> 'Cancel'
       and upper(regexp_replace(coalesce(o.tally_bill_no, ''), '\s', '', 'g')) = ${key}
     limit 1
  `)) as unknown as { n: number }[];
  return hit ? Number(hit.n) : null;
}

function readInvoice(values: Record<string, string>): { no: string; key: string; date: string } | Result<never> {
  const no = text(values.invoiceNo);
  const key = invoiceKey(no);
  if (!no || !key) return fieldErr("invoiceNo", "The Tally invoice number is required");
  const date = text(values.invoiceDate);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fieldErr("invoiceDate", "The invoice date is required");
  return { no, key, date };
}

/**
 * BILL IT: the office has made the bill in Tally, and records its number and
 * date against the WHOLE order, which then waits for the invoice check. One
 * order is one complete bill (rule 1), and one invoice number belongs to one
 * order — a number already on another order is refused, naming it.
 */
async function doBill(ctx: ErpContext, id: string, values: Record<string, string>) {
  const inv = readInvoice(values);
  if ("ok" in inv) return inv;
  const [order] = [...(await wholeOrders([id])).values()];
  if (!order?.length) return err("That line no longer exists.", "not_found");
  const no = order[0].o.orderNo;
  const blockers = billBlockersFor(order);
  if (blockers.length) return err(`Order ${no} cannot be billed yet: it needs ${blockers.join("; ")}.`, "rule_violation");
  const other = await invoiceTakenBy(no, inv.key);
  if (other != null) return fieldErr("invoiceNo", `Invoice ${inv.no} is already on order ${other}. One invoice is one order.`);
  const live = order.filter((l) => l.o.status !== "Cancel");
  await db.transaction(async (tx) => {
    await tx
      .update(erpOrders)
      .set({ tallyBillNo: inv.no, invoiceDate: inv.date, entryStatus: "Done", updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpOrders.id, live.map((l) => l.o.id)));
    await tx
      .insert(erpOrderDetails)
      .values(live.map((l) => ({ orderId: l.o.id, invoiceCheck: "Pending", createdById: ctx.user.id, updatedById: ctx.user.id })))
      .onConflictDoNothing();
    await addReview(tx, ctx, no, "invoice", "submitted", `Invoice ${inv.no} of ${fd(inv.date)}`, {
      invoiceNo: inv.no,
      invoiceDate: inv.date,
      lines: live.map((l) => ({ id: l.o.id, sku: l.sku.name, qty: l.o.qtyCans, rate: l.o.ratePaise, discount: l.o.discountBp })),
    });
  });
  await erpAudit(ctx, "erp.order.bill", "erp_order", live.map((l) => l.o.id).join(","), null, { invoiceNo: inv.no, invoiceDate: inv.date });
  await syncBookOrders([no]);
  await tell(await holdersOf("checkInvoices"), `Invoice to check · order ${no}`, `${live[0].billing.name}: invoice ${inv.no}, ${plural(live.length)}.`, erpLink("invoiceCheck", {}));
  return okVoid(`Order ${no} billed · invoice ${inv.no}`);
}

/** Taking an order back out of billing, until it has been dispatch-verified. Its invoice check goes with it. */
async function doUnbill(ctx: ErpContext, ids: string[]) {
  const orders = await wholeOrders(ids);
  const back: OrderLine[] = [];
  const refused: string[] = [];
  for (const [no, order] of orders) {
    const billed = order.filter((l) => l.inDetails);
    if (!billed.length) continue;
    if (billed.some((l) => l.dispatched)) refused.push(`order ${no} has been dispatch-verified`);
    else back.push(...billed);
  }
  if (!back.length) return err(refused.length ? `Not undone: ${refused.join("; ")}.` : "Only a billed order that has not been dispatch-verified goes back.", "rule_violation");
  const ids2 = back.map((l) => l.o.id);
  const nos = [...new Set(back.map((l) => l.o.orderNo))];
  await db.transaction(async (tx) => {
    await tx.delete(erpOrderDetails).where(inArray(erpOrderDetails.orderId, ids2));
    await tx.update(erpOrders).set({ entryStatus: "Not Done", updatedAt: new Date(), updatedById: ctx.user.id }).where(inArray(erpOrders.id, ids2));
    for (const n of nos) await addReview(tx, ctx, n, "invoice", "reset", "Billing undone");
  });
  await erpAudit(ctx, "erp.order.unbill", "erp_order", ids2.join(","));
  await syncBookOrders(nos);
  return okVoid(`Order${nos.length === 1 ? "" : "s"} ${nos.join(", ")} back out of billing`);
}

async function doChangeInvoice(ctx: ErpContext, id: string, values: Record<string, string>) {
  const inv = readInvoice(values);
  if ("ok" in inv) return inv;
  const [order] = [...(await wholeOrders([id])).values()];
  const billed = (order ?? []).filter((l) => l.inDetails);
  if (!billed.length) return err("The order is not billed; Bill it records the invoice.", "rule_violation");
  if (billed.some((l) => l.dispatched)) return err("The order has been dispatch-verified.", "rule_violation");
  const no = billed[0].o.orderNo;
  const other = await invoiceTakenBy(no, inv.key);
  if (other != null) return fieldErr("invoiceNo", `Invoice ${inv.no} is already on order ${other}. One invoice is one order.`);
  const before = invoiceSnapshot(order);
  await db
    .update(erpOrders)
    .set({ tallyBillNo: inv.no, invoiceDate: inv.date, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(inArray(erpOrders.id, billed.map((l) => l.o.id)));
  await erpAudit(ctx, "erp.order.invoice", "erp_order", String(no), { invoiceNo: before.invoiceNo, invoiceDate: before.invoiceDate }, { invoiceNo: inv.no, invoiceDate: inv.date });
  await reopenInvoiceCheck(ctx, no, before);
  await syncBookOrders([no]);
  return okVoid(`Invoice on order ${no} is now ${inv.no}`);
}

/* ---------------------------------------- step 6: the independent invoice check */

async function invoiceForCheck(ctx: ErpContext, id: string): Promise<{ no: number; billed: OrderLine[]; order: OrderLine[] } | Result<never>> {
  if (!ctx.powers.has("checkInvoices")) return err("The invoice checker approves invoices: it needs the Check invoices power.", "not_permitted");
  const [order] = [...(await wholeOrders([id])).values()];
  const billed = (order ?? []).filter((l) => l.inDetails && l.o.status !== "Cancel");
  if (!billed.length) return err("That order is not billed.", "rule_violation");
  if (billed.some((l) => l.dispatched)) return err("The order has been dispatch-verified.", "rule_violation");
  /* PRD step 6 and §8: the checker is not the person who entered the bill. */
  if (!ctx.administrator && billed.some((l) => l.billedById === ctx.user.id)) return err("You entered this bill, so somebody else checks it.", "not_permitted");
  return { no: billed[0].o.orderNo, billed, order: order! };
}

async function doApproveInvoice(ctx: ErpContext, id: string) {
  const got = await invoiceForCheck(ctx, id);
  if ("ok" in got) return got;
  if (got.billed.every((l) => l.invoiceCheck === "Approved")) return err("That invoice is already approved.", "rule_violation");
  await db.transaction(async (tx) => {
    await tx
      .update(erpOrderDetails)
      .set({ invoiceCheck: "Approved", invoiceCheckedById: ctx.user.id, invoiceCheckedAt: new Date(), invoiceCheckNote: null, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpOrderDetails.orderId, got.billed.map((l) => l.o.id)));
    await addReview(tx, ctx, got.no, "invoice", "approved", null, invoiceSnapshot(got.order) as unknown as Record<string, unknown>);
  });
  await erpAudit(ctx, "erp.invoice.approve", "erp_order", String(got.no));
  return okVoid(`Invoice ${got.billed[0].o.tallyBillNo ?? ""} approved · order ${got.no} can be dispatched`);
}

async function doRejectInvoice(ctx: ErpContext, id: string, values: Record<string, string>) {
  const reason = text(values.reason);
  if (!reason) return fieldErr("reason", "Say why the invoice is rejected");
  const got = await invoiceForCheck(ctx, id);
  if ("ok" in got) return got;
  await db.transaction(async (tx) => {
    await tx
      .update(erpOrderDetails)
      .set({ invoiceCheck: "Rejected", invoiceCheckedById: ctx.user.id, invoiceCheckedAt: new Date(), invoiceCheckNote: reason, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpOrderDetails.orderId, got.billed.map((l) => l.o.id)));
    await addReview(tx, ctx, got.no, "invoice", "rejected", reason, invoiceSnapshot(got.order) as unknown as Record<string, unknown>);
  });
  await erpAudit(ctx, "erp.invoice.reject", "erp_order", String(got.no), null, { reason });
  await tell(
    got.billed.map((l) => l.billedById),
    `Invoice rejected · order ${got.no}`,
    `${got.billed[0].billing.name}, invoice ${got.billed[0].o.tallyBillNo ?? ""}: ${reason}`,
    erpLink("invoiceCheck", {}),
    "warn",
  );
  return okVoid(`Invoice on order ${got.no} rejected and returned for correction`);
}

/* ---------------------------------------- step 7: the stickers are on */

async function doStickers(ctx: ErpContext, ids: string[]) {
  const ls = (await lines(ids)).filter((l) => isStickerLine(l) && !l.stickersAt);
  if (!ls.length) return err("Only a line under process, ready or billed, and not yet dispatched, takes its stickers.", "rule_violation");
  const ids2 = ls.map((l) => l.o.id);
  const at = new Date();
  /* On the LINE, because stickers now go on before billing and a line has no
     order-details row until it is billed; mirrored onto the bill where there
     is one, which the Billing & dispatch tab reads. */
  await db.transaction(async (tx) => {
    await tx.update(erpOrders).set({ stickersAt: at, stickersById: ctx.user.id, updatedAt: at, updatedById: ctx.user.id }).where(inArray(erpOrders.id, ids2));
    await tx.update(erpOrderDetails).set({ stickersAt: at, stickersById: ctx.user.id, updatedAt: at, updatedById: ctx.user.id }).where(inArray(erpOrderDetails.orderId, ids2));
  });
  await erpAudit(ctx, "erp.detail.stickers", "erp_order_detail", ls.map((l) => l.o.id).join(","));
  return okVoid(`Dispatch stickers recorded · ${plural(ls.length)}`);
}

/* ------------------------------------- rule 2: goods that go later, on a new order */

async function doMoveOut(ctx: ErpContext, id: string, values: Record<string, string>) {
  const [l] = await lines([id]);
  if (!l) return err("That line no longer exists.", "not_found");
  if (l.inDetails) return err("A billed line stays on its bill.", "rule_violation");
  if (l.o.status === "Cancel") return err("The line is cancelled.", "rule_violation");
  if (l.allocations) return err("Release its batch codes first; they hold stock for this order.", "rule_violation");
  const split = splitForMove(l.o.qtyCans, int(values.qty) ?? 0, l.sku.cpb, !l.boxed);
  if (!split.ok) return fieldErr("qty", split.reason);
  let newNo = 0;
  await db.transaction(async (tx) => {
    newNo = await nextNumber(tx, "order");
    const rest: Partial<typeof l.o> = { ...l.o };
    delete rest.createdAt;
    delete rest.updatedAt;
    await tx.insert(erpOrders).values({
      ...(rest as typeof l.o),
      id: `ODID-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      orderNo: newNo,
      qtyCans: split.moves,
      status: "Under Process",
      entryStatus: "Not Done",
      tallyBillNo: null,
      invoiceDate: null,
      linkedFromOrderNo: l.o.orderNo,
      source: "erp",
      sourceRef: null,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    if (split.stays > 0) await tx.update(erpOrders).set({ qtyCans: split.stays, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpOrders.id, id));
    else await tx.delete(erpOrders).where(eq(erpOrders.id, id));
    await addReview(tx, ctx, l.o.orderNo, "order", "reset", `${nf(split.moves)} cans of ${l.sku.name} moved to order ${newNo}, to go later`);
  });
  await erpAudit(ctx, "erp.order.moveOut", "erp_order", id, { orderNo: l.o.orderNo, qty: l.o.qtyCans }, { newOrderNo: newNo, moved: split.moves, stays: split.stays });
  await syncBookOrders([l.o.orderNo, newNo]);
  return okVoid(`${nf(split.moves)} cans of ${l.sku.name} moved to order ${newNo}, linked to order ${l.o.orderNo}`);
}

function lineHandlers(scope: Scope): Pick<ScreenModule, "actions" | "bulk" | "forms" | "formLoaders"> {
  return {
    bulk: {
      verifyOrder: (ctx, ids) => doVerifyOrder(ctx, ids),
      unverifyOrder: (ctx, ids) => doUnverifyOrder(ctx, ids),
      ready: (ctx, ids) => doReady(ctx, ids),
      underProcess: (ctx, ids) => doUnder(ctx, ids),
      hold: (ctx, ids) => doStatus(ctx, ids, "Hold From Office"),
      async cancel(ctx, ids, values) {
        const refusal = await confirmImpact("erp-order-cancel", impactBatchKey(ids), readConfirmation(values));
        return refusal ?? doStatus(ctx, ids, "Cancel");
      },
      async unbill(ctx, ids, values) {
        const refusal = await confirmImpact("erp-order-unbill", impactBatchKey(ids), readConfirmation(values));
        return refusal ?? doUnbill(ctx, ids);
      },
      approve: (ctx, ids) => doApprove(ctx, ids),
      stickers: (ctx, ids) => doStickers(ctx, ids),
    },
    actions: {
      verifyOrder: (ctx, id) => doVerifyOrder(ctx, [id]),
      unverifyOrder: (ctx, id) => doUnverifyOrder(ctx, [id]),
      correctOrder: (ctx, id, values) => doCorrectOrder(ctx, id, values),
      ready: (ctx, id) => doReady(ctx, [id]),
      underProcess: (ctx, id) => doUnder(ctx, [id]),
      hold: (ctx, id) => doStatus(ctx, [id], "Hold From Office"),
      async cancel(ctx, id, values) {
        const refusal = await confirmImpact("erp-order-cancel", id, readConfirmation(values));
        return refusal ?? doStatus(ctx, [id], "Cancel");
      },
      bill: (ctx, id, values) => doBill(ctx, id, values),
      async unbill(ctx, id, values) {
        const refusal = await confirmImpact("erp-order-unbill", id, readConfirmation(values));
        return refusal ?? doUnbill(ctx, [id]);
      },
      changeInvoice: (ctx, id, values) => doChangeInvoice(ctx, id, values),
      approveInvoice: (ctx, id) => doApproveInvoice(ctx, id),
      rejectInvoice: (ctx, id, values) => doRejectInvoice(ctx, id, values),
      stickers: (ctx, id) => doStickers(ctx, [id]),
      moveOut: (ctx, id, values) => doMoveOut(ctx, id, values),
      approve: (ctx, id) => doApprove(ctx, [id]),
      async delete(ctx, id, values) {
        const [l] = await lines([id]);
        if (!l) return err("That line no longer exists.", "not_found");
        if (l.inDetails) return err("A billed line is not deleted; undo its billing first.", "rule_violation");
        if (l.allocations) return err("Release its batch codes first; they hold stock.", "rule_violation");
        /* Also refuses — as a sentence, not a foreign-key error — a line a box
           was scanned against, a dispatch override names, or a return came back on. */
        const refusal = await confirmImpact("erp-order-line", id, readConfirmation(values));
        if (refusal) return refusal;
        await db.transaction(async (tx) => {
          /* Mahek Plus's retired follow-up remark held the line by a foreign
             key, so a line that carried one could never be deleted at all. */
          await tx.delete(erpFollowups).where(eq(erpFollowups.orderId, id));
          await tx.delete(erpOrders).where(eq(erpOrders.id, id));
        });
        await erpAudit(ctx, "erp.order.delete", "erp_order", id, l.o, null);
        await reopenOrderCheck(ctx, l.o.orderNo, `${l.sku.name} deleted`);
        await syncBookOrders([l.o.orderNo]);
        return okVoid("Line deleted");
      },
    },
    formLoaders: {
      edit: editForm,
      editOrder: editOrderForm,
      allocate: allocateForm,
      async more(ctx, id) {
        const [l] = await lines([id]);
        if (!l) return null;
        return orderForm(ctx, { orderNo: l.o.orderNo, date: l.o.orderDate, godown: l.godown, billing: l.billing.name, delivery: l.delivery.name, transporter: l.o.transporter ?? "", source: l.o.orderSource ?? "" });
      },
    },
    forms: {
      ...(scope === "orders" ? { new: (ctx, h, ls) => saveOrder(ctx, h, ls) } : {}),
      more: (ctx, h, ls) => saveOrder(ctx, h, ls),
      edit: (ctx, h, _l, id) => saveEdit(ctx, h, id),
      editOrder: (ctx, h, ls, id) => saveEditOrder(ctx, h, ls, id),
      allocate: (ctx, h, _l, id) => saveAllocation(ctx, h, id),
    },
  };
}

async function partyByName(name: string | null): Promise<CustomerRow | null> {
  if (!name) return null;
  const [p] = await loadCustomers(eq(customers.name, name));
  return p ?? null;
}

/**
 * Third-party shops: delivered to, billed through a distributor. They are
 * mostly leads with no dispatch profile, so the party book leaves them out —
 * but they are exactly who a delivery party usually is.
 */
async function thirdPartyShops(): Promise<CustomerRow[]> {
  return (await loadCustomers(eq(customers.thirdParty, true), { any: true })).filter((p) => partyStatus(p) !== "Deactive");
}

function withShops(names: string[], shops: CustomerRow[]): string[] {
  return [...new Set([...names, ...shops.map((p) => p.name)])].sort((a, b) => a.localeCompare(b));
}

/**
 * The delivery party a form names. Read from the whole book, not just the
 * party book, preferring an account we invoice and then a third-party shop
 * where two records share a name. Blank means the billing party; a name that
 * matches nobody is refused rather than quietly becoming the billing party.
 */
async function deliveryByName(name: string | null, fallback: CustomerRow): Promise<Result<CustomerRow>> {
  if (!name) return { ok: true, data: fallback };
  const rank = (p: CustomerRow) => (p.kind === "customer" ? 0 : p.thirdParty ? 1 : 2);
  const [p] = (await loadCustomers(eq(customers.name, name), { any: true })).filter((c) => partyStatus(c) !== "Deactive").sort((a, b) => rank(a) - rank(b));
  return p ? { ok: true, data: p } : fieldErr("delivery", `No party named "${name}". Pick one from the list, or leave it blank to deliver to the billing party.`);
}

async function saveOrder(ctx: ErpContext, h: Record<string, string>, ls: Record<string, string>[]): Promise<Result<unknown>> {
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const billing = await partyByName(text(h.billing));
  if (!billing) return fieldErr("billing", "Billing party is required");
  if (partyStatus(billing) === "Deactive") return fieldErr("billing", "This party is deactivated");
  /* A draft read off a WhatsApp message came by WhatsApp, whatever the form was sent with. */
  const source = text(h.source) ?? (text(h.inboxId) ? "WhatsApp" : null);
  if (!source || !(ORDER_SOURCES as readonly string[]).includes(source)) return fieldErr("source", "Say how the order was received");
  const named = await deliveryByName(text(h.delivery), billing);
  if (!named.ok) return named;
  const delivery = named.data;
  if (!ls.length) return err("Add at least one SKU.");
  const [skus, prices] = await Promise.all([skuCatalogue(), priceBook([billing.id])]);
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
    const listRate = prices.rateOf(billing.id, sku);
    /* Somebody who cannot see the rate cannot set it either: the list decides. */
    const typedRate = seeRate ? paise(l.rate) : null;
    const typedDisc = seeAmounts ? num(l.discount) : null;
    if (typedDisc != null && (typedDisc < 0 || typedDisc > 100)) return fieldErr(`l${i}.discount`, "Discount must be between 0 and 100");
    parsed.push({
      sku,
      qty,
      rate: typedRate ?? listRate,
      discount: typedDisc != null ? Math.round(typedDisc * 100) : null,
      remark: text(l.remark),
    });
  }
  const fixed = int(h.orderFixed);
  const date = text(h.date) ?? today();
  if (fixed != null) {
    /* One order is one bill: a billed order takes no more lines. */
    const existing = await orderLines({ orderNos: [fixed] });
    if (existing.some((l) => l.inDetails && l.o.status !== "Cancel")) return err(`Order ${fixed} is billed. One order is one bill — take a new order for these goods.`, "rule_violation");
  } else if (text(h.dupOk) !== DUP_OK) {
    /* PRD step 1: the reliable duplicate — the same party, day and goods. */
    const same = (await db.execute(sql`
      select order_no as "orderNo", sku_id as "skuId", qty_cans as "qtyCans" from erp_orders
       where billing_customer_id = ${billing.id} and order_date = ${date} and status <> 'Cancel'
    `)) as unknown as { orderNo: number; skuId: string; qtyCans: number }[];
    const shapes = new Map<number, { skuId: string; qtyCans: number }[]>();
    for (const r of same) shapes.set(Number(r.orderNo), [...(shapes.get(Number(r.orderNo)) ?? []), { skuId: r.skuId, qtyCans: Number(r.qtyCans) }]);
    const dup = likelyDuplicate(
      { billingId: billing.id, date, lines: parsed.map((p) => ({ skuId: p.sku.id, qtyCans: p.qty })) },
      [...shapes].map(([orderNo, lines]) => ({ orderNo, billingId: billing.id, date, lines })),
    );
    if (dup != null) return fieldErr("dupOk", `Order ${dup} for ${billing.name} on this day has exactly these goods. If this is a separate order, pick "${DUP_OK}" and save again.`);
  }
  let no = 0;
  await db.transaction(async (tx) => {
    no = fixed ?? (await nextNumber(tx, "order"));
    for (const p of parsed)
      await tx.insert(erpOrders).values({
        id: `ODID-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        orderNo: no,
        orderDate: date,
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
        dispatchOn: text(h.dispatchOn),
        orderSource: source,
        orderCheck: "Pending",
        createdById: ctx.user.id,
        updatedById: ctx.user.id,
      });
    if (fixed == null) await addReview(tx, ctx, no, "order", "submitted", `Received by ${source}`);
  });
  await erpAudit(ctx, "erp.order.create", "erp_order", String(no), null, { lines: parsed.length, billing: billing.name, source });
  /* A line added to a verified order is not what was verified. */
  if (fixed != null) await reopenOrderCheck(ctx, fixed, `${plural(parsed.length)} added`);
  await syncBookOrders([no]);
  /* AI-2: an order accepted from a drafted message closes that message, linked to the order. */
  const inboxId = text(h.inboxId);
  if (inboxId) await (await import("../ai-orders")).markConverted(ctx, inboxId, no);
  const noRate = parsed.filter((p) => p.rate == null).length;
  const applied = prices.listOf(billing.id);
  return okVoid(
    `Order ${no} saved · ${plural(parsed.length)} · waiting for the back office to verify${noRate ? ` · ${noRate} without a rate: ${applied ? `none on ${applied.name}` : "no price list applies to the party"}` : ""}`,
  );
}

async function saveEdit(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  if (!id) return err("No line named.", "not_found");
  const [l] = await lines([id]);
  if (!l) return err("That line no longer exists.", "not_found");
  const status = text(h.status);
  if (!status || !ORDER_STATUSES.includes(status)) return fieldErr("status", "Status is required");
  const qty = int(h.qty);
  if (qty == null || qty <= 0) return fieldErr("qty", "Minus Quantity Not Allowed");
  if (l.inDetails && qty !== l.o.qtyCans) return fieldErr("qty", "This line is billed; its quantity is fixed");
  if (!boxQuantity(qty, l.sku.cpb, !l.boxed).valid) return fieldErr("qty", "INVALID");
  /* Ready through the edit form is the same claim as the Ready button, checked the same way. */
  if (status === "Ready" && l.o.status !== "Ready") {
    if (l.o.orderCheck !== "Verified") return fieldErr("status", "The back office has not verified this order yet");
    const need = Math.max(0, allocationTarget(l.boxed, boxQuantity(qty, l.sku.cpb, !l.boxed).boxes, qty) - l.allocated);
    const short = (await stockShortfalls([{ l, need }])).get(l.o.id);
    if (short) return fieldErr("status", `Stock is not there: ${short}`);
  }
  const named = await deliveryByName(text(h.delivery), l.delivery);
  if (!named.ok) return named;
  const delivery = named.data;
  const values: Partial<typeof erpOrders.$inferInsert> = {
    status,
    dispatchOn: text(h.dispatchOn),
    qtyCans: qty,
    deliveryCustomerId: l.inDetails ? l.o.deliveryCustomerId : delivery.id,
    transporter: await knownTransporterName(db, text(h.transporter), ctx.user.id),
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
  const order = await orderLines({ orderNos: [l.o.orderNo] });
  const before = invoiceSnapshot(order);
  await db.transaction(async (tx) => {
    await tx.update(erpOrders).set({ ...values, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpOrders.id, id));
    /* The bill took the order's transporter when it was raised, and the
       Logistics desk reads the bill — so a changed transporter follows onto
       it. Not where an LR is attached: the goods are already with whoever
       issued that LR, and the LR is the word on who has them. */
    if (values.transporter && values.transporter !== l.o.transporter)
      await tx
        .update(erpTransports)
        .set({ transporter: values.transporter, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(and(eq(erpTransports.orderNo, l.o.orderNo), isNull(erpTransports.lrId)));
  });
  await erpAudit(ctx, "erp.order.edit", "erp_order", id, l.o, values);
  /* What the back office verified, or what the checker approved, has to be looked at again when it moves. */
  const material = [
    qty !== l.o.qtyCans ? "quantity" : "",
    (values.deliveryCustomerId ?? l.o.deliveryCustomerId) !== l.o.deliveryCustomerId ? "delivery party" : "",
    "ratePaise" in values && (values.ratePaise ?? null) !== (l.o.ratePaise ?? null) ? "rate" : "",
    "discountBp" in values && (values.discountBp ?? null) !== (l.o.discountBp ?? null) ? "discount" : "",
  ].filter(Boolean);
  if (l.inDetails) await reopenInvoiceCheck(ctx, l.o.orderNo, before);
  else if (material.length) await reopenOrderCheck(ctx, l.o.orderNo, `${l.sku.name}: ${material.join(", ")} changed`);
  await syncBookOrders([l.o.orderNo]);
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

const BATCH_WINDOW = { label: "Allocation date", default: "month" } as const;

const batchCodes: ScreenModule = {
  key: "batchCodes",
  window: BATCH_WINDOW,
  async load(ctx, s) {
    const scope = s ?? unscoped();
    const where = windowWhere(sql`(${erpBatchCodes.createdAt} at time zone ${APP_TIMEZONE})::date`, sql`${erpBatchCodes.id}`, scope);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(erpBatchCodes).where(where);
    const wide = tooWide(Number(n), scope);
    const [rows, fg, pack] = await Promise.all([
      db
        .select({ b: erpBatchCodes, o: erpOrders, sku: products.name, godown: erpGodowns.name, by: users.name, verified: erpOrderDetails.verification })
        .from(erpBatchCodes)
        .innerJoin(erpOrders, eq(erpOrders.id, erpBatchCodes.orderId))
        .innerJoin(products, eq(products.id, erpOrders.skuId))
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpBatchCodes.godownId))
        .leftJoin(erpOrderDetails, eq(erpOrderDetails.orderId, erpOrders.id))
        .leftJoin(users, eq(users.id, erpBatchCodes.createdById))
        .where(wide ? sql`false` : where)
        .orderBy(desc(erpBatchCodes.createdAt)),
      fgLots(),
      packLots(),
    ]);
    const fgRate = new Map(fg.map((l) => [`${l.finishedGoodId}|${l.lotCode}`, l.ratePaise]));
    const packRate = new Map(pack.map((l) => [l.batchNo, l.perCanPaise]));
    const all: Col[] = [
      { k: "orderNo", l: "Order no", t: "mono" },
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
      spec: { screen: "batchCodes", cols, hidden, groups: ["godown"], godownKey: "godown", noDataLine: "No lots allocated yet. Lots are allocated on the Dispatch desk, by scanning the boxes." },
      tooWide: wide,
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
            { id: "release", l: "Release", why: dispatched ? "The order has been dispatch-verified" : "", impact: { kind: "erp-batch-release", id: r.b.id } },
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
        const onIt = await scannedOnAllocation(b.orderId, b.lotCode);
        if (qty < onIt) return refuse(fieldErr("qty", `${onIt} scanned box${onIt === 1 ? " is" : "es are"} on this lot; take them off at the Dispatch desk first`));
        if (qty > required + 1e-9 || qty > stock + b.quantity + 1e-9) return refuse(fieldErr("qty", "Invalid Quantity Or Wait For Synchronization"));
        await tx.update(erpBatchCodes).set({ quantity: qty }).where(eq(erpBatchCodes.id, id));
        await erpAudit(ctx, "erp.batchCode.qty", "erp_batch_code", id, { quantity: b.quantity }, { quantity: qty });
        return okVoid("Allocation saved");
      });
    },
    async release(ctx, id, values) {
      const [b] = await db.select().from(erpBatchCodes).where(eq(erpBatchCodes.id, id));
      if (!b) return err("That allocation no longer exists.", "not_found");
      const refusal = await confirmImpact("erp-batch-release", id, readConfirmation(values));
      if (refusal) return refusal;
      const [d] = await db.select({ v: erpOrderDetails.verification }).from(erpOrderDetails).where(eq(erpOrderDetails.orderId, b.orderId));
      if (d?.v === "Verified") return err("The order has been dispatch-verified.", "rule_violation");
      /* A billed line was billed on these lots. Taking one away would leave a
         bill for goods no longer set aside, so billing is undone first. */
      if (d) return err("The line is billed. Undo its billing first.", "rule_violation");
      const onIt = await scannedOnAllocation(b.orderId, b.lotCode);
      if (onIt) return err(`${onIt} box${onIt === 1 ? " is" : "es are"} scanned against this lot; take ${onIt === 1 ? "it" : "them"} off at the Dispatch desk first.`, "rule_violation");
      await db.delete(erpBatchCodes).where(eq(erpBatchCodes.id, id));
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
  /** Credit notes issued on this line's bill and goods, before GST. */
  creditNote: number | null;
  monthId: string | null;
};

/**
 * What the credit notes issued against a line's bill and goods take off its
 * margin. A credit note comes off the bill WITH GST, and the margin is before
 * GST, so it is taken back to the line's own rate.
 */
function creditOf(credits: Map<string, number>, l: OrderLine, gstBp: number): number | null {
  const paid = credits.get(`${l.o.billingCustomerId}|${l.o.tallyBillNo ?? ""}|${l.sku.name}`);
  return paid == null ? null : Math.round((paid * 10000) / (10000 + gstBp));
}

/**
 * Billed lines, with their figures. `f` says which, in SQL (`LineFilter`); it
 * is always narrowed to billed lines. With `withUnverified` the lines still
 * waiting for dispatch verification are added whatever the window — they are
 * work, and a period that hid them would hide the backlog.
 *
 * The MONTHLY sale (a customer's dispatched value in a month) is a fact about
 * whole months, so it is summed over every billed line in the months the rows
 * fall in, not over the rows a window happens to hold.
 */
export async function detailRows(f: LineFilter, opts: { withUnverified?: boolean } = {}): Promise<{ rows: DetailRow[]; billTotal: Map<string, number>; monthly: Map<string, number> }> {
  const [main, open] = await Promise.all([
    orderLines({ ...f, billed: true }),
    opts.withUnverified ? orderLines({ billed: true, openWork: true }) : Promise.resolve([] as OrderLine[]),
  ]);
  const seen = new Set(main.map((l) => l.o.id));
  const ls = [...main, ...open.filter((l) => !seen.has(l.o.id))];
  const ids = ls.map((l) => l.o.id);
  const [details, costs, credits] = await Promise.all([
    ids.length ? db.select().from(erpOrderDetails).where(inArray(erpOrderDetails.orderId, ids)) : Promise.resolve([] as (typeof erpOrderDetails.$inferSelect)[]),
    allocationCosts(ids),
    issuedCreditNotes(),
  ]);
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
      margin: margin({ amountPaise: bill.amountPaise, discountedPaise: bill.discountedPaise, costingPaise: costing, creditNotePaise: creditOf(credits, l, d.gstBp) }),
      creditNote: creditOf(credits, l, d.gstBp),
      monthId: monthId(d.dispatchDate),
    });
  }
  const billTotal = new Map<string, number>();
  for (const r of rows) {
    const bk = `${r.l.o.orderNo}|${r.l.o.billingCustomerId}`;
    billTotal.set(bk, (billTotal.get(bk) ?? 0) + (r.final ?? 0));
  }
  return { rows, billTotal, monthly: await monthlySalesFor(rows.map((r) => r.d.dispatchDate)) };
}

/**
 * Each customer's dispatched value per month (keyed `<monthId>|<customer>`),
 * for the months these days fall in — each summed over the WHOLE month, so a
 * period that cuts a month in half cannot halve the figure beside it.
 */
export async function monthlySalesFor(days: (string | null)[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const months = [...new Set(days.map((d) => d?.slice(0, 7)).filter((m): m is string => !!m))];
  for (const m of months) {
    const w = monthWindow(m);
    const scope: LoadScope = { pd: `c:${w.from}:${w.to}`, window: w, ids: null, open: null };
    const ls = await orderLines({ billed: true, window: { scope, on: "dispatch" } });
    const ds = ls.length ? await db.select({ id: erpOrderDetails.orderId, gst: erpOrderDetails.gstBp, day: erpOrderDetails.dispatchDate }).from(erpOrderDetails).where(inArray(erpOrderDetails.orderId, ls.map((l) => l.o.id))) : [];
    const d = new Map(ds.map((x) => [x.id, x]));
    for (const l of ls) {
      const x = d.get(l.o.id);
      const id = monthId(x?.day ?? null);
      if (!x || !id) continue;
      const bill = billFigures({ type: l.type, qtyCans: l.o.qtyCans, litresPerCan: l.sku.litresPerCan, ratePaise: l.o.ratePaise, discountBp: l.o.discountBp, transportCostPaise: l.o.transportCostPaise, gstBp: x.gst });
      const mk = `${id}|${l.o.billingCustomerId}`;
      out.set(mk, (out.get(mk) ?? 0) + (bill.amountPaise ?? 0));
    }
  }
  return out;
}

/** Each order line's allocated lots' costing, per can (or per litre on a drum lot). */
async function allocationCosts(orderIds: string[]): Promise<Map<string, (number | null)[]>> {
  if (!orderIds.length) return new Map();
  /* The rates of the lots these lines drew — usually used up by now, so asked for by name rather than read off stock. */
  const codes = await db.select().from(erpBatchCodes).where(inArray(erpBatchCodes.orderId, orderIds));
  const [fg, pack] = await Promise.all([
    fgRates([...new Set(codes.filter((b) => b.lotFrom !== "pack").map((b) => b.lotCode))]),
    packBatchCosting([...new Set(codes.filter((b) => b.lotFrom === "pack").map((b) => b.lotCode))]),
  ]);
  const fgRate = new Map([...fg].map(([k, v]) => [k, v.ratePaise]));
  const packRate = new Map([...pack].map(([k, c]) => [k, c.amountPaise == null || !c.cans ? null : Math.round(c.amountPaise / c.cans)]));
  const out = new Map<string, (number | null)[]>();
  for (const b of codes) {
    const c = b.lotFrom === "pack" ? (packRate.get(b.lotCode) ?? null) : (fgRate.get(`${b.finishedGoodId}|${b.lotCode}`) ?? null);
    out.set(b.orderId, [...(out.get(b.orderId) ?? []), c]);
  }
  return out;
}

/** Order details is a register too: billed lines by dispatch date, plus every line still awaiting verification. */
const DETAILS_WINDOW = { label: "Dispatch date", default: "month" } as const;

const orderDetails: ScreenModule = {
  key: "orderDetails",
  window: DETAILS_WINDOW,
  async load(ctx, s) {
    const scope = s ?? unscoped();
    const f: LineFilter = scope.ids?.length ? { ids: scope.ids } : { window: { scope, on: "dispatch" } };
    const wide = scope.ids?.length ? null : tooWide(await countLines({ ...f, billed: true }), scope);
    const [{ rows, billTotal, monthly }, targetRows] = await Promise.all([
      wide ? Promise.resolve({ rows: [] as DetailRow[], billTotal: new Map<string, number>(), monthly: new Map<string, number>() }) : detailRows(f, { withUnverified: !scope.ids?.length }),
      db.execute(sql`select customer_id as c, year as y, month as m, target_amount as t from monthly_targets`) as unknown as Promise<{ c: string; y: number; m: number; t: number }[]>,
    ]);
    /* The customer's target for the month a line was dispatched in — the CRM's
       Monthly Targets, the one customer target in MahekOne. */
    const targets = new Map(targetRows.map((x) => [`${x.c}|${monthId(`${x.y}-${String(x.m).padStart(2, "0")}-01`)}`, Number(x.t)]));
    const byNo = new Map<number, string[]>();
    rows.forEach((r) => byNo.set(r.l.o.orderNo, [...(byNo.get(r.l.o.orderNo) ?? []), r.l.o.id]));
    const gates = await scanGateFor(db, rows.filter((r) => r.d.verification !== "Verified").map((r) => r.l.o.id));
    const all: Col[] = [
      ...orderCols(["date", "orderNo", "billing", "sku", "qty"]),
      { k: "amount", l: "Amount", t: "m", pw: "viewSalesAmounts" },
      orderCol("rate"),
      { k: "billTotal", l: "Bill total", t: "m", pw: "viewSalesAmounts" },
      orderCol("discount"),
      { k: "dispatchDate", l: "Dispatch date", t: "d" },
      { k: "invoiceCheck", l: "Invoice check", t: "s" },
      { k: "verification", l: "Dispatch", t: "s" },
      { k: "vehicle", l: "Vehicle", t: "mono" },
      { k: "follow", l: "Transport follow-up", t: "t" },
      { k: "monthly", l: "Monthly sale", t: "m", pw: "viewSalesAmounts" },
      { k: "si", l: "Standing instructions", t: "t" },
      { k: "discounted", l: "Discounted amount", t: "m", pw: "viewSalesAmounts" },
      ...orderCols(["area", "transporter"]),
      { k: "transport", l: "Transport cost", t: "m" },
      { k: "extra", l: "Extra expenses", t: "m" },
      orderCol("bill"),
      { k: "payment", l: "Payment type", t: "t", pw: "viewCost" },
      { k: "margin", l: "Margin", t: "m", pw: "viewCost" },
      { k: "monthId", l: "Month", t: "t" },
      ...orderCols(["godown", "f"]),
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    const amounts = ctx.powers.has("viewSalesAmounts");
    const cost = ctx.powers.has("viewCost");
    return {
      spec: {
        screen: "orderDetails",
        cols,
        hidden,
        groups: ["orderNo"],
        groupHead: ["date", "billing", "billTotal", "dispatchDate", "bill", "transporter", "area", "godown"],
        godownKey: "godown",
        bulk: [
          { id: "verify", l: "Confirm dispatch", prompt: DISPATCH_PROMPT("Every selected order leaves whole: each needs its invoice approved and every box scanned.") },
          { id: "extra", l: "Extra expenses", prompt: EXTRA_EXPENSE_PROMPT },
        ],
        noDataLine: "Nothing billed yet. An order arrives here once it is billed; it is dispatched after its invoice is approved.",
      },
      tooWide: wide,
      rows: rows
        .sort((a, b) => (a.l.o.orderDate < b.l.o.orderDate ? 1 : a.l.o.orderDate > b.l.o.orderDate ? -1 : b.d.createdAt.getTime() - a.d.createdAt.getTime()))
        .map((r): ListRow => {
          const l = r.l;
          const d = r.d;
          const monthSale = r.monthId ? (monthly.get(`${r.monthId}|${l.o.billingCustomerId}`) ?? 0) : 0;
          const target = r.monthId ? (targets.get(`${l.o.billingCustomerId}|${r.monthId}`) ?? null) : null;
          const flags: string[] = [];
          if (!d.verification || d.verification === "Pending") flags.push("notVerified");
          const gate = gates.get(l.o.id) ?? null;
          if (gate) flags.push("toScan");
          if (d.verification !== "Verified") flags.push(d.invoiceCheck === "Approved" ? "invoiceApproved" : d.invoiceCheck === "Rejected" ? "invoiceRejected" : "invoiceToCheck");
          if (d.stickersAt) flags.push("stickersOn");
          if (d.verification === "Verified" && !d.vehicleNo) flags.push("noVehicle");
          if (r.monthId && targetReached(monthSale, target)) flags.push("targetReached");
          const verifiable = !d.verification || d.verification === "Pending";
          /* The invoice check is optional: only a REJECTED invoice holds the goods — the checker found the bill wrong. */
          const approved = d.invoiceCheck !== "Rejected";
          const actions: ActionSpec[] = [
            {
              id: "verify",
              l: d.verification === "Verified" ? "Dispatched" : "Confirm dispatch",
              primary: verifiable && !gate && approved,
              why: d.verification === "Verified" ? "Already dispatched" : !approved ? "The invoice was rejected; correct it first" : gate ? `Boxes to scan: ${gate}` : "",
              prompt: DISPATCH_PROMPT(`Order ${l.o.orderNo} leaves whole — every billed line of it.`),
            },
            { id: "stickers", l: "Stickers are on", why: d.verification === "Verified" ? "It has left" : d.stickersAt ? "Already recorded" : "" },
            ...(ctx.administrator && d.verification !== "Not Verify" ? [{ id: "notVerify", l: "Mark not verified", impact: { kind: "erp-dispatch-unverify", id: d.orderId } } as ActionSpec] : []),
            {
              id: "extra",
              l: "Extra expenses",
              why: d.extraExpensesPaise != null ? "Already entered" : "",
              prompt: EXTRA_EXPENSE_PROMPT,
            },
            { id: "gst", l: "Change GST", why: d.verification === "Verified" ? "The line has been dispatch-verified" : "", prompt: { title: "GST", submit: "Save", fields: [{ k: "gst", l: "GST", t: "select", req: true, opts: ["18%", "0%"] }], init: { gst: d.gstBp ? "18%" : "0%" } } },
            { id: "select", l: "Show the whole order", href: erpLink("orderDetails", { f: (byNo.get(l.o.orderNo) ?? []).join(","), fl: `Order ${l.o.orderNo}` }) },
            { id: "view", l: "View order", href: erpLink("orders", { open: l.o.id }) },
            { id: "scan", l: gate ? "Scan its boxes" : "Dispatch desk", primary: !!gate, href: erpDispatchHref(l.o.orderNo) },
            { id: "labels", l: "Print dispatch stickers", href: approved && d.verification !== "Verified" ? erpLabelsHref({ order: l.o.orderNo }) : undefined, why: d.verification === "Verified" ? "It has left" : approved ? "" : "After the invoice is approved" },
            { id: "trace", l: "Trace this order", href: erpTraceHref(orderTraceCode(l.o.orderNo)) },
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
                invoiceCheck: d.invoiceCheck,
                verification: d.verification === "Verified" ? "Dispatched" : d.verification === "Not Verify" ? "Not verified" : gate ? "Scanning" : approved ? "Ready to dispatch" : "Pending",
                vehicle: d.vehicleNo,
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
                    { l: "Credit note amount (before GST)", v: r.creditNote == null ? "—" : inr(r.creditNote) },
                  ]
                : []),
              { l: "Order fulfil days", v: d.dispatchDate ? String(daysBetween(l.o.orderDate, d.dispatchDate)) : "—", der: true },
              { l: "Credit days", v: credit == null ? "—" : String(credit), der: true },
              { l: "Due date", v: d.dispatchDate && credit != null ? fd(addDaysIso(d.dispatchDate, credit)) : "—", der: true },
              { l: "Segment and counter type", v: `${l.delivery.p?.segment ?? ""} ${(l.delivery.p?.counterTypes ?? []).join(", ")}`.trim() || "—", der: true },
              { l: "Sales man", v: l.delivery.salesPerson ?? "—", der: true },
              ...(amounts ? [{ l: "Monthly target", v: target == null ? "—" : inr(target), der: true }] : []),
              { l: "Dispatch status", v: d.dispatchStatus },
              { l: "Tally invoice", v: `${l.o.tallyBillNo ?? "—"}${l.o.invoiceDate ? ` · ${fd(l.o.invoiceDate)}` : ""}` },
              { l: "Invoice check", v: d.invoiceCheck === "Approved" ? (d.invoiceCheckedAt ? `Approved · ${stamp(d.invoiceCheckedAt)}` : "Approved") : d.invoiceCheck === "Rejected" ? `Rejected — ${d.invoiceCheckNote ?? ""}` : "Waiting for the checker" },
              { l: "Dispatch stickers", v: d.stickersAt ? `On · ${stamp(d.stickersAt)}` : "Not recorded" },
              ...(d.verification === "Verified" ? [{ l: "Vehicle", v: d.vehicleNo ?? "Not recorded" }, { l: "Driver / transporter", v: d.driver ?? "—" }, { l: "Dispatch remark", v: d.dispatchRemark ?? "—" }] : []),
            ],
            actions,
            by: stampLine(null, d.createdAt).replace(/^Created/, "Added to order details"),
          };
        }),
    };
  },
  bulk: {
    verify: (ctx, ids, values) => verify(ctx, ids, values),
    extra: (ctx, ids, values) => setExtraExpenses(ctx, ids, values),
    stickers: (ctx, ids) => doStickers(ctx, ids),
  },
  actions: {
    verify: (ctx, id, values) => verify(ctx, [id], values),
    stickers: (ctx, id) => doStickers(ctx, [id]),
    extra: (ctx, id, values) => setExtraExpenses(ctx, [id], values),
    async notVerify(ctx, id, values) {
      if (!ctx.administrator) return err("Only an administrator marks a line not verified.", "not_permitted");
      const refusal = await confirmImpact("erp-dispatch-unverify", id, readConfirmation(values));
      if (refusal) return refusal;
      await db.update(erpOrderDetails).set({ verification: "Not Verify", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpOrderDetails.orderId, id));
      await erpAudit(ctx, "erp.detail.notVerify", "erp_order_detail", id);
      await syncBookOrders(await orderNosOf([id]));
      return okVoid("Marked not verified");
    },
    async gst(ctx, id, values) {
      const gst = values.gst === "0%" ? 0 : values.gst === "18%" ? 1800 : null;
      if (gst == null) return fieldErr("gst", "GST is required");
      const [d] = await db.select().from(erpOrderDetails).where(eq(erpOrderDetails.orderId, id));
      if (!d) return err("That line is not in order details.", "not_found");
      if (d.verification === "Verified") return err("The line has been dispatch-verified.", "rule_violation");
      const nos = await orderNosOf([id]);
      const before = invoiceSnapshot(await orderLines({ orderNos: nos }));
      await db.update(erpOrderDetails).set({ gstBp: gst, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpOrderDetails.orderId, id));
      for (const n of nos) await reopenInvoiceCheck(ctx, n, before);
      await erpAudit(ctx, "erp.detail.gst", "erp_order_detail", id, { gstBp: d.gstBp }, { gstBp: gst });
      await syncBookOrders(await orderNosOf([id]));
      return okVoid(`GST ${values.gst} · billed by ${gst ? "Mahek Marketing India" : "Mylac"}`);
    },
  },
};

/** What dispatch records as the goods leave (PRD step 9) — asked on the row, the bulk bar and the Dispatch desk alike. */
export const DISPATCH_PROMPT = (sub: string): NonNullable<ActionSpec["prompt"]> => ({
  title: "Confirm dispatch",
  sub,
  submit: "Dispatch",
  fields: [
    { k: "date", l: "Dispatch date", t: "date", req: true },
    { k: "vehicle", l: "Vehicle / tempo / truck no.", t: "text", hint: "Bills on the same vehicle the same day travel as one trip in Logistics." },
    { k: "driver", l: "Driver or transporter", t: "text" },
    { k: "remark", l: "Dispatch remark or exception", t: "area", mic: true },
  ],
  init: { date: today() },
});

/**
 * CONFIRM DISPATCH: the date, the vehicle, Verified and Dispatched, stamped.
 *
 * An order leaves WHOLE (rule 1 — one order, one bill): asking for one line
 * dispatches every billed line of its order, and the order goes only when its
 * invoice has been APPROVED by the checker (step 6) and every box on it has
 * been scanned. Goods that will go later were moved to an order of their own
 * before billing, so there is no part to leave behind.
 */
async function verify(ctx: ErpContext, ids: string[], values: Record<string, string>): Promise<Result<unknown>> {
  const date = text(values.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fieldErr("date", "Dispatch date is required");
  const vehicle = text(values.vehicle)?.toUpperCase().replace(/\s+/g, " ") ?? null;
  const driver = text(values.driver);
  const remark = text(values.remark);
  const orders = await wholeOrders(ids);
  const details = await db.select().from(erpOrderDetails).where(inArray(erpOrderDetails.orderId, [...orders.values()].flat().map((l) => l.o.id)));
  const d = new Map(details.map((x) => [x.orderId, x]));
  const go: OrderLine[] = [];
  const refused: string[] = [];
  for (const [no, order] of orders) {
    const billed = order.filter((l) => l.inDetails && l.o.status !== "Cancel");
    const waiting = billed.filter((l) => {
      const v = d.get(l.o.id)?.verification;
      return !v || v === "Pending";
    });
    if (!waiting.length) {
      refused.push(`order ${no} has ${billed.length ? "already left" : "no bill"}`);
      continue;
    }
    const unbilled = order.filter((l) => l.o.status !== "Cancel" && !l.inDetails);
    if (unbilled.length) {
      refused.push(`order ${no} has ${plural(unbilled.length)} not on its bill`);
      continue;
    }
    if (waiting.some((l) => d.get(l.o.id)?.invoiceCheck !== "Approved")) {
      refused.push(`order ${no}'s invoice ${waiting.some((l) => d.get(l.o.id)?.invoiceCheck === "Rejected") ? "was rejected" : "is waiting for the invoice check"}`);
      continue;
    }
    const earlier = waiting.find((l) => date < l.o.orderDate);
    if (earlier) return fieldErr("date", `Order ${earlier.o.orderNo} was taken on ${fd(earlier.o.orderDate)}; it cannot leave before that`);
    go.push(...waiting);
  }
  /* A line whose lots carry box ids leaves only once every box on it has been scanned at the dispatch desk — and the order leaves whole, so one unscanned line holds it. */
  const gates = await scanGateFor(db, go.map((l) => l.o.id));
  const held = new Set(go.filter((l) => gates.get(l.o.id)).map((l) => l.o.orderNo));
  for (const no of held) {
    const l = go.find((x) => x.o.orderNo === no && gates.get(x.o.id))!;
    refused.push(`order ${no} · ${l.sku.name} has ${gates.get(l.o.id)} still to scan at the Dispatch desk`);
  }
  const leaving = go.filter((l) => !held.has(l.o.orderNo));
  if (!leaving.length) return err(`Not dispatched: ${refused.join("; ")}.`, "rule_violation");
  await db.transaction(async (tx) => {
    await tx
      .update(erpOrderDetails)
      .set({ verification: "Verified", dispatchStatus: "Dispatched", dispatchedAt: new Date(), dispatchDate: date, vehicleNo: vehicle, driver, dispatchRemark: remark, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(inArray(erpOrderDetails.orderId, leaving.map((l) => l.o.id)));
    await markDispatched(tx, leaving.map((l) => l.o.id), ctx.user.id, date);
    /* §18: what was verified together leaves as one consignment, and reaches Logistics now — on the trip its vehicle makes. */
    await openTransports(tx, leaving, date, ctx.user.id, new Map([...d].map(([k, v]) => [k, v.extraExpensesPaise ?? null])));
  });
  const nos = [...new Set(leaving.map((l) => l.o.orderNo))];
  await erpAudit(ctx, "erp.detail.verify", "erp_order_detail", leaving.map((l) => l.o.id).join(","), null, { dispatchDate: date, vehicle, driver, remark });
  await syncBookOrders(nos);
  /* Logistics picks it up from here: boxes, tracking link, the first line of its timeline. */
  await (await import("../logistics")).afterDispatch(ctx, nos);
  return okVoid(`Dispatched · order${nos.length === 1 ? "" : "s"} ${nos.join(", ")}${vehicle ? ` on ${vehicle}` : " · no vehicle recorded"}${refused.length ? `. Not dispatched: ${refused.join("; ")}` : ""}`);
}

/* ======================================================= the hand-over to Logistics */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * DISPATCH-VERIFIED LINES BECOME A CONSIGNMENT, every time. Lines of one order
 * and one bill verified together are one `erp_transports` row; a line verified
 * later joins that row only while it is still at the gate (no LR, not yet at
 * the transporter) and was opened by a verify of this order. Anything else —
 * an order shipped in a second go, or an order number that already carries a
 * row from the Taken Order history, closed or on the road — opens a row of its
 * own. Until 0279 the table was unique on the order number and those lines
 * opened nothing, so they never reached Logistics.
 *
 * Writes `erp_order_details.transport_id` for each line. Returns the order
 * numbers touched, for `afterDispatch`.
 */
export async function openTransports(
  tx: Tx | typeof db,
  ls: OrderLine[],
  date: string,
  userId: string | null,
  extra: Map<string, number | null> = new Map(),
): Promise<number[]> {
  const groups = new Map<string, OrderLine[]>();
  for (const l of ls) {
    const k = `${l.o.orderNo}|${l.o.tallyBillNo ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const g of groups.values()) {
    const first = g[0];
    /* A line already on a consignment (verified, un-verified, verified again) stays on it. */
    const have = (await tx.execute(sql`
      select d.order_id as id, d.transport_id as tid from erp_order_details d
        join erp_transports t on t.id = d.transport_id
       where d.order_id in ${g.map((l) => l.o.id)}
    `)) as unknown as { id: string; tid: string }[];
    const placed = new Set(have.map((h) => h.id));
    const rest = g.filter((l) => !placed.has(l.o.id));
    if (!rest.length) continue;
    const [open] = (await tx.execute(sql`
      select t.id from erp_transports t
       where t.order_no = ${first.o.orderNo}
         and coalesce(t.bill_no, '') = ${first.o.tallyBillNo ?? ""}
         and t.lr_id is null and coalesce(t.lr_no, '') = ''
         and t.material_stage = 'Dispatched'
         and exists (select 1 from erp_order_details d where d.transport_id = t.id)
       order by t.created_at desc
       limit 1
       for update
    `)) as unknown as { id: string }[];
    let tid = open?.id ?? null;
    if (!tid) {
      const [taken] = (await tx.execute(sql`select 1 from erp_transports where id = ${rest[0].o.id}`)) as unknown as unknown[];
      tid = taken ? erpId("etrn") : rest[0].o.id;
      const expense = rest.map((l) => extra.get(l.o.id)).find((v) => v != null) ?? null;
      await tx.insert(erpTransports).values({
        id: tid,
        orderNo: first.o.orderNo,
        billDate: date,
        billingCustomerId: first.o.billingCustomerId,
        billNo: first.o.tallyBillNo,
        transporter: first.o.transporter ?? first.delivery.p?.transporter ?? null,
        area: first.delivery.area,
        paymentType: first.billing.freightTerm,
        extraExpensePaise: expense,
        updatedById: userId,
      });
    }
    await tx.update(erpOrderDetails).set({ transportId: tid }).where(inArray(erpOrderDetails.orderId, rest.map((l) => l.o.id)));
    /* The vehicle dispatch recorded puts the bill on that vehicle's trip for the day (PRD step 10). */
    const [veh] = (await tx.execute(sql`
      select d.vehicle_no as "vehicleNo", d.driver from erp_order_details d
       where d.order_id in ${rest.map((l) => l.o.id)} and d.vehicle_no is not null
       limit 1
    `)) as unknown as { vehicleNo: string | null; driver: string | null }[];
    await assignTripsAtDispatch(tx, [{ transportId: tid, date, vehicleNo: veh?.vehicleNo ?? null, driver: veh?.driver ?? null, transporter: first.o.transporter ?? first.delivery.p?.transporter ?? null }], userId);
  }
  return [...new Set(ls.map((l) => l.o.orderNo))];
}

/**
 * THE NET UNDER THE HAND-OVER. Every line dispatch-verified in the last
 * `erp.logistics.syncDays` that is on no consignment gets one, dated its own
 * dispatch date — the lines the old one-row-per-order rule skipped, and any a
 * failed write left behind. Run when Logistics opens and hourly; a line already
 * placed costs nothing.
 */
export async function syncDispatchedTransports(userId: string | null, days: number): Promise<number> {
  const rows = (await db.execute(sql`
    select d.order_id as id, d.dispatch_date::text as date
      from erp_order_details d
     where d.verification = 'Verified'
       and d.dispatch_date is not null
       and d.dispatch_date >= (now() at time zone ${APP_TIMEZONE})::date - ${days}::int
       and (d.transport_id is null or not exists (select 1 from erp_transports t where t.id = d.transport_id))
  `)) as unknown as { id: string; date: string }[];
  if (!rows.length) return 0;
  const all = await lines(rows.map((r) => r.id));
  const byDate = new Map<string, OrderLine[]>();
  const dateOf = new Map(rows.map((r) => [r.id, r.date]));
  for (const l of all) {
    const day = dateOf.get(l.o.id)!;
    byDate.set(day, [...(byDate.get(day) ?? []), l]);
  }
  const extras = new Map(
    (await db.select({ id: erpOrderDetails.orderId, x: erpOrderDetails.extraExpensesPaise }).from(erpOrderDetails).where(inArray(erpOrderDetails.orderId, all.map((l) => l.o.id)))).map((r) => [r.id, r.x ?? null]),
  );
  const orderNos = new Set<number>();
  for (const [day, ls] of byDate) {
    const nos = await db.transaction((tx) => openTransports(tx, ls, day, userId, extras));
    nos.forEach((n) => orderNos.add(n));
  }
  if (orderNos.size) await (await import("../logistics")).afterDispatchFor(userId, [...orderNos]);
  return all.length;
}

/** Asked wherever a line's extra expenses are entered: Orders → Billing & dispatch and Logistics → Paid freight. */
export const EXTRA_EXPENSE_PROMPT: NonNullable<ActionSpec["prompt"]> = {
  title: "Enter extra expenses",
  submit: "Save",
  fields: [{ k: "amount", l: "Extra expenses (₹)", t: "num", req: true, min: 0 }],
};

/**
 * ONE writer for a line's extra expenses, whichever screen it is entered on.
 * The bill's transport record carries the same figure (copied when it opened),
 * so it is written there too — Orders used to skip that half.
 */
export async function setExtraExpenses(ctx: ErpContext, ids: string[], values: Record<string, string>): Promise<Result<unknown>> {
  const amount = paise(values.amount);
  if (amount == null || amount < 0) return fieldErr("amount", "Extra expenses are required");
  const res = await db
    .update(erpOrderDetails)
    .set({ extraExpensesPaise: amount, updatedAt: new Date(), updatedById: ctx.user.id })
    .where(and(inArray(erpOrderDetails.orderId, ids), sql`${erpOrderDetails.extraExpensesPaise} is null`))
    .returning({ id: erpOrderDetails.orderId });
  if (!res.length) return err("Extra expenses are already entered on these lines.", "rule_violation");
  await db.execute(sql`
    update erp_transports t set extra_expense_paise = ${amount}
     where t.extra_expense_paise is null
       and (t.id in ${res.map((r) => r.id)}
            or t.id in (select d.transport_id from erp_order_details d where d.order_id in ${res.map((r) => r.id)}))
  `);
  await erpAudit(ctx, "erp.detail.extra", "erp_order_detail", res.map((r) => r.id).join(","), null, { amount });
  return okVoid(`Extra expenses on ${plural(res.length)}`);
}

/* ============================================================ dispatch register */

/**
 * WHAT IS STILL TO GO OUT, for the dispatch team: every line Under Process or
 * Ready that has not been dispatch-verified — who it is billed to, where it is
 * delivered, what it is, what it weighs and who carries it. Nothing that has
 * left is here; that is Billing & dispatch and Logistics. A billed line still
 * on the floor stays until it is verified, because the lorry has not taken it.
 *
 * Read-only: every column carries an Excel filter (`ListSpec.colFilters`), and
 * the work itself is done where it always was — a row opens the order on the
 * Orders screen, the dispatch desk or the sticker print.
 */
export function isRegisterLine(l: OrderLine): boolean {
  return (
    (l.o.status === "Under Process" || l.o.status === "Ready") &&
    !l.dispatched &&
    /* An old sheet line finished outside the ERP (entry Done, never billed here) is not waiting for anything. */
    (l.o.entryStatus !== "Done" || l.inDetails)
  );
}

const DUE_SHORT: Record<NonNullable<Due>, string> = { today: "Today", tomorrow: "Tomorrow", late: "Late" };

const dispatchRegister: ScreenModule = {
  key: "dispatchRegister",
  async load(ctx, s) {
    const all = s?.ids?.length ? await orderLines({ ids: s.ids }) : await orderLines({ openWork: true });
    const shown = all.filter(isRegisterLine);
    const cols: Col[] = [
      orderCol("orderNo", { l: "Order ID" }),
      orderCol("billing", { l: "Customer (billing party)" }),
      orderCol("delivery"),
      orderCol("sku", { l: "Product" }),
      orderCol("weight", { l: "Weight" }),
      orderCol("transporter", { l: "Transport" }),
      orderCol("status"),
      { k: "dispatchOn", l: "Dispatch on", t: "d" },
      { k: "when", l: "Due", t: "t" },
      orderCol("qty", { l: "Cans" }),
      orderCol("boxes"),
      orderCol("city", { l: "Delivery city" }),
      orderCol("bill", { l: "Bill no." }),
      orderCol("date"),
      orderCol("godown"),
    ];
    return {
      spec: {
        screen: "dispatchRegister",
        cols,
        hidden: [],
        readOnly: true,
        colFilters: true,
        /* Ticking rows reads what they add up to — the lorry is booked by the weight. */
        selectSum: [
          { k: "weight", l: "kg", missing: "without a weight" },
          { k: "boxes", l: "boxes", one: "box" },
          { k: "qty", l: "cans", one: "can" },
          { k: "orderNo", l: "orders", one: "order", kind: "distinct" },
          { k: "delivery", l: "delivery parties", one: "delivery party", kind: "distinct" },
        ],
        chips: "status",
        groups: ["orderNo"],
        groupSel: true,
        agg: [
          { k: "boxes", l: "boxes" },
          { k: "weight", l: "kg", missing: "without a weight" },
        ],
        godownKey: "godown",
        noDataLine: "Nothing waiting to go out. Lines appear here once they are Under Process or Ready, and leave once they are dispatch-verified.",
      },
      rows: shown.map((l): ListRow => ({
        id: l.o.id,
        v: {
          orderNo: String(l.o.orderNo),
          billing: l.billing.name,
          delivery: l.delivery.name,
          sku: l.sku.name,
          weight: l.weightKg,
          transporter: l.o.transporter ?? l.delivery.p?.transporter ?? "—",
          status: l.o.status,
          dispatchOn: l.o.dispatchOn,
          when: l.due ? DUE_SHORT[l.due] : l.o.dispatchOn ? "Later" : "Not planned",
          qty: l.o.qtyCans,
          boxes: l.boxed ? l.boxes : null,
          city: l.delivery.city,
          bill: l.o.tallyBillNo,
          date: l.o.orderDate,
          godown: l.godown,
        },
        flags: lineFlags(l),
        title: l.delivery.name,
        header: [`Order ${l.o.orderNo}`, l.due ? DUE_WORD[l.due] : "", l.si.replace(/( - )+$/, "")].filter(Boolean).join(" · "),
        fields: [
          { l: "Billing party", v: l.billing.name },
          { l: "Delivery party", v: `${l.delivery.name}${l.delivery.city ? ` · ${l.delivery.city}` : ""}` },
          { l: "Product", v: `${l.sku.name} · ${nf(l.o.qtyCans)} cans${l.boxed ? ` · ${nf(l.boxes)} boxes` : ""}` },
          { l: "Weight", v: l.weightKg == null ? "No weight in the catalogue for this SKU" : `${nf(l.weightKg)} kg`, der: true },
          { l: "Transport", v: l.o.transporter ?? l.delivery.p?.transporter ?? "—" },
          { l: "Dispatch on", v: l.o.dispatchOn ? fd(l.o.dispatchOn) : "Not planned" },
          { l: "Tally invoice", v: l.o.tallyBillNo ? `${l.o.tallyBillNo}${l.o.invoiceDate ? ` · ${fd(l.o.invoiceDate)}` : ""}` : "Not billed yet" },
          { l: "Standing instructions", v: l.si || "—", der: true },
          { l: "Remark / customer instructions", v: l.o.remark || "—" },
        ],
        actions: [
          { id: "open", l: "Open the order", primary: true, href: erpLink("readyOrders", { f: l.o.id, fl: `Order ${l.o.orderNo}` }) },
          ...(l.o.status === "Ready" ? [{ id: "scan", l: "Scan boxes at dispatch", href: erpDispatchHref(l.o.orderNo) } as ActionSpec] : []),
          { id: "labels", l: "Print dispatch stickers", href: erpLabelsHref({ order: l.o.orderNo }) },
        ],
        by: stampLine(l.by, l.o.createdAt),
      })),
    };
  },
};

export const SALES_SCREENS: ScreenModule[] = [
  orderList("orders"),
  orderList("verifyOrders"),
  orderList("pendingOrders"),
  orderList("readyOrders"),
  orderList("toBill"),
  orderList("invoiceCheck"),
  batchCodes,
  orderList("labels"),
  orderDetails,
  dispatchRegister,
];
