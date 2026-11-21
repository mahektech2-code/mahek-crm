import "server-only";
import { EVIDENCE_FIELDS } from "../engines/sfg-tests";
import { getConfig } from "@/lib/config/store";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { adjustStockRow, stockRowActions } from "../stock-adjust";
import { erpStockInquiryHref } from "../stock-links";
import { erpTraceHref } from "../trace-links";
import { erpLink } from "../registry";
import { inWindow, STOCK_ROW_CAP, STOCK_WINDOW, tooWide, unscoped, windowWhere } from "../window";
import { db } from "@/db";
import {
  erpGodowns,
  erpInward,
  erpLabelPrints,
  erpPoCorrections,
  erpPoLines,
  erpPrCosts,
  erpPurchaseOrders,
  erpPurchases,
  erpRawMaterials,
  erpRmEntries,
  erpSuppliers,
  erpTests,
  users,
} from "@/db/schema";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import { holdsTick } from "../action-ticks";
import { testingTeamFor } from "../departments";
import { powerRefusal, type ErpContext } from "../access";
import { refValues } from "../refs";
import { erpLabelsHref } from "../trace-links";
import {
  erpAudit,
  erpId,
  int,
  nextNumber,
  num,
  paise,
  rupeesField,
  stampLine,
  text,
  visibleCols,
  withoutHidden,
  type ScreenModule,
} from "../server";
import type { ActionSpec, ColSpec, FieldSpec, FormSpec, ListRow, PromptSpec } from "../ui";
import { fd, inr, inrRate, nf } from "../ui";
import {
  TRANSPORT_MODES,
  lotNumber,
  netWeight,
  postsToStock,
  prBillLabel,
  purchaseFigures,
  settableStatuses,
  shortLabel,
  transportCostPaise,
  transportModeByLabel,
  transportModeLabel,
} from "../engines/purchase";
import { lockLot, lotLandings, rmLots, type LotLanding } from "../stock";
import { foldRmLots, lotRowId } from "../engines/stock-fold";
import { bindErpFiles } from "../attachments";
import { type Col, godownField, godownIdByName, godownOptions, has, inTx, refuse, today, type Tx } from "./common";
import { confirmImpact } from "@/lib/impact/registry";
import { readConfirmation } from "@/lib/impact/types";
import { EXTRA_OPTS, RECEIVABLE_PO, SHORT_OPTS, correctionFor, normalisePoNo, poLabel, poName, receiptGap } from "../engines/purchase-flow";
import { OWNERSHIP_LABEL, ownershipByLabel } from "../engines/drums";
import { STOCK_WORDS, testBucket, waitedTooLong, waitingText } from "../engines/lot-testing";
import { MAX_COPIES as MAX_LABEL_COPIES } from "../engines/labels";

/** The GRN line's drum ownership: the supplier's usual answer unless the line says otherwise. */
const DRUM_OWNER_OPTS = ["As the supplier's master says", OWNERSHIP_LABEL.mahek, OWNERSHIP_LABEL.returnable];
import { sortPoLines, type GrnItem, type GrnPoLine } from "../engines/grn-pick";
import { poOption, purchaseOrderViews, refreshPurchaseOrder, type PoView } from "./purchase-flow";
import { deliveryWords } from "../engines/purchase-flow";
import { expectedAtGate, gateGroupLine, supplierDelivery, whatsNext, type GateLine, type GateRow, type GrnNext, type SavedGrnLine } from "../engines/goods-in";
import { REGISTER_DEFAULT } from "../period";
import { roundedTotal } from "@/lib/bill-round";

/* ---------------------------------------------------------------------------
 * Purchase (spec §5): goods inward (the GRN), testing, the purchase register
 * and the barcode export — and posting purchases to raw-material stock (§6.2).
 * Requirements, quotations and POs — the steps before the goods arrive — are
 * `purchase-flow.ts`. NOTHING IS RECEIVED OR REGISTERED WITHOUT A PO: inward
 * and a hand-entered register row both name an approved PO's line, and the
 * lot is registered at that line's rate and GST.
 * ------------------------------------------------------------------------- */



function itemsByType(mats: { name: string; materialType: string }[], types: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of types) out[t] = mats.filter((m) => m.materialType === t).map((m) => m.name);
  return out;
}

/* =============================================================== postings */

/** The register's posting, for the bill-reading review (AI-1) to save through. */
export async function syncPurchaseEntryPublic(tx: Tx, purchaseId: string) {
  return syncPurchaseEntry(tx, purchaseId);
}

/**
 * Posts (or re-syncs) a purchase's entry in the raw-material log: one entry
 * per purchase, quantity = its available litres, at its godown under its lot.
 * Only a purchase with a rate above zero posts; once posted, the entry follows
 * the purchase through every edit, because the source reads it as a live
 * formula on the purchase (spec §6.1).
 */
async function syncPurchaseEntry(tx: Tx, purchaseId: string): Promise<boolean> {
  const [p] = await tx.select().from(erpPurchases).where(eq(erpPurchases.id, purchaseId));
  if (!p) return false;
  const [existing] = await tx
    .select({ id: erpRmEntries.id })
    .from(erpRmEntries)
    .where(and(eq(erpRmEntries.sourceType, "purchase"), eq(erpRmEntries.sourceId, purchaseId)));
  if (!existing && !postsToStock(p.ratePaise)) return false;
  const values = {
    entryDate: p.purchaseDate,
    rawMaterialId: p.rawMaterialId,
    lotNo: p.lotNo,
    godownId: p.godownId,
    quantity: p.availableLitres,
  };
  if (existing) {
    await tx.update(erpRmEntries).set(values).where(eq(erpRmEntries.id, existing.id));
  } else {
    await tx.insert(erpRmEntries).values({ id: erpId("rme"), sourceType: "purchase", sourceId: purchaseId, ...values });
  }
  return true;
}

/** What a register row takes from the PO line it was bought on: the PO, and its rate and GST. */
function poTerms(poNumber: number, poId: string, line: { id: string; ratePaise: number; gstBp: number }) {
  return { poNumber: poLabel(poNumber), poId, poLineId: line.id, ratePaise: line.ratePaise, gstBp: line.gstBp };
}

/** The PO terms for a row whose inward line names a PO line, read back from the database (legacy lines name none). */
async function poTermsOfInward(tx: Tx, inward: { poId: string | null; poLineId: string | null } | null | undefined) {
  if (!inward?.poId || !inward.poLineId) return {};
  const [x] = await tx
    .select({ n: erpPurchaseOrders.poNumber, rate: erpPoLines.ratePaise, gst: erpPoLines.gstBp })
    .from(erpPoLines)
    .innerJoin(erpPurchaseOrders, eq(erpPurchaseOrders.id, erpPoLines.poId))
    .where(eq(erpPoLines.id, inward.poLineId));
  return x ? poTerms(x.n, inward.poId, { id: inward.poLineId, ratePaise: x.rate, gstBp: x.gst }) : {};
}

/**
 * Creates a register row (from an inward line, a verified test, or by hand).
 * The lot number must be new: the source's own message says what to do when it
 * is not.
 */
async function createPurchase(
  tx: Tx,
  ctx: ErpContext,
  v: {
    prNumber: number;
    purchaseDate: string;
    supplierId: string;
    rawMaterialId: string;
    quantity: number;
    unit: string;
    godownId: string;
    drums?: number | null;
    weightWithDrum?: number | null;
    density?: number | null;
    remark?: string | null;
    source: "inward" | "test" | "manual";
    inwardId?: string | null;
    poId?: string | null;
    poLineId?: string | null;
    testId?: string | null;
    ratePaise?: number | null;
    poNumber?: string | null;
    feedAdjustedLitre?: number;
    feedAdjustedAmountPaise?: number;
    gstBp?: number;
    company?: string;
    billNumber?: string | null;
    notes?: string | null;
  },
): Promise<Result<{ id: string; lotNo: string }>> {
  const [sup] = await tx.select().from(erpSuppliers).where(eq(erpSuppliers.id, v.supplierId));
  const [mat] = await tx.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, v.rawMaterialId));
  if (!sup || !mat) return err("The supplier or the item no longer exists.", "not_found");
  const lotNo = lotNumber(sup.partyCode, mat.code, v.prNumber);
  const [clash] = await tx.select({ id: erpPurchases.id }).from(erpPurchases).where(eq(erpPurchases.lotNo, lotNo));
  if (clash) return fieldErr("prNumber", "That PR number is already taken. Change it, or generate a new one.");
  const unit = v.unit === "Kg" || v.unit === "Litre" || v.unit === "Pcs" ? v.unit : mat.unit === "Kg" ? "Kg" : mat.unit === "Litre" ? "Litre" : "Pcs";
  const density = v.density ?? mat.density ?? null;
  const fig = purchaseFigures({
    quantity: v.quantity,
    unit,
    ratePaise: v.ratePaise ?? null,
    density,
    feedAdjustedLitre: v.feedAdjustedLitre ?? 0,
    feedAdjustedAmountPaise: v.feedAdjustedAmountPaise ?? 0,
    gstBp: v.gstBp ?? 1800,
    drums: v.drums ?? null,
  });
  const id = v.source === "inward" && v.inwardId ? v.inwardId : v.source === "test" && v.testId ? v.testId : erpId("prb");
  await tx.insert(erpPurchases).values({
    id,
    prNumber: v.prNumber,
    purchaseDate: v.purchaseDate,
    poNumber: v.poNumber ?? null,
    supplierId: v.supplierId,
    rawMaterialId: v.rawMaterialId,
    lotNo,
    quantity: v.quantity,
    unit,
    ratePaise: v.ratePaise ?? null,
    density,
    drums: v.drums ?? null,
    weightWithDrum: v.weightWithDrum ?? null,
    feedAdjustedLitre: v.feedAdjustedLitre ?? 0,
    feedAdjustedAmountPaise: v.feedAdjustedAmountPaise ?? 0,
    gstBp: v.gstBp ?? 1800,
    availableLitres: fig.availableLitres,
    company: v.company ?? "Mahek Marketing India",
    billNumber: v.billNumber ?? null,
    notes: v.notes ?? null,
    remark: v.remark ?? null,
    godownId: v.godownId,
    testId: v.testId ?? null,
    inwardId: v.inwardId ?? null,
    poId: v.poId ?? null,
    poLineId: v.poLineId ?? null,
    source: v.source,
    createdById: ctx.user.id,
    updatedById: ctx.user.id,
  });
  await syncPurchaseEntry(tx, id);
  return { ok: true, data: { id, lotNo } };
}

/* ============================================================== inward */

/*
 * TRANSPORT AND OTHER INWARD COST, once per PR. The same fields open on a new
 * inward and on "Transport & costs" for one already saved, and `readPrCosts`
 * is the one reading of them both saves go through.
 */
const OWN = { k: "transportMode", eq: transportModeLabel("own_vehicle") };
const BILLED_MODES = { k: "transportMode", in: [transportModeLabel("supplier"), transportModeLabel("third_party")] };
const COST_FIELDS: FieldSpec[] = [
  { k: "transportMode", l: "Transport mode", t: "select", req: true, sec: "Transport and landing cost", opts: TRANSPORT_MODES.map((m) => m.label) },
  {
    k: "transportCost",
    l: "Transport cost (₹)",
    t: "num",
    req: true,
    min: 0,
    when: BILLED_MODES,
    hint: "Supplier: the freight on their invoice, with its GST. Third-party: the transporter's bill.",
  },
  { k: "km", l: "Kilometres", t: "num", req: true, min: 0.1, when: OWN },
  { k: "ownCost", l: "Transport cost", t: "derived", calc: "inward.ownCost", when: OWN },
  { k: "tempo", l: "Tempo number", t: "text", reqWhen: OWN, when: { k: "transportMode", in: [transportModeLabel("supplier"), transportModeLabel("own_vehicle"), transportModeLabel("third_party")] } },
  { k: "otherCost", l: "Other direct inward cost (₹)", t: "num", min: 0, hint: "Loading, unloading, octroi — anything paid to get these goods in." },
  { k: "otherNote", l: "What the other cost was", t: "text", when: { k: "otherCost", notEmpty: true } },
  { k: "landing", l: "Landing cost", t: "derived", calc: "inward.landing" },
];

function costInit(c: typeof erpPrCosts.$inferSelect | undefined): Record<string, string> {
  if (!c) return {};
  return {
    transportMode: transportModeLabel(c.transportMode),
    transportCost: c.transportMode === "supplier" || c.transportMode === "third_party" ? rupeesField(c.transportCostPaise) : "",
    km: c.km == null ? "" : String(c.km),
    tempo: c.tempoNumber ?? "",
    otherCost: c.otherCostPaise ? rupeesField(c.otherCostPaise) : "",
    otherNote: c.otherCostNote ?? "",
  };
}

/**
 * The cost fields as a row to store, or the field that is wrong. Our own
 * vehicle is costed here from the APPROVED rate, which is copied onto the row
 * — a rate changed next month must not reprice this journey — unless the PR
 * already carries one and the kilometres did not change.
 */
function readPrCosts(
  h: Record<string, string>,
  ratePerKmPaise: number,
  kept?: typeof erpPrCosts.$inferSelect,
): Result<Omit<typeof erpPrCosts.$inferInsert, "prNumber">> {
  const mode = transportModeByLabel(text(h.transportMode));
  if (!mode) return fieldErr("transportMode", "Transport mode is required");
  const billed = paise(h.transportCost);
  if ((mode === "supplier" || mode === "third_party") && (billed == null || billed < 0)) return fieldErr("transportCost", "Transport cost is required");
  const km = num(h.km);
  if (mode === "own_vehicle" && (km == null || km <= 0)) return fieldErr("km", "Kilometres are required");
  const tempo = text(h.tempo);
  if (mode === "own_vehicle" && !tempo) return fieldErr("tempo", "Tempo number is required");
  const rate = mode !== "own_vehicle" ? null : kept?.transportMode === "own_vehicle" && kept.km === km && kept.ratePerKmPaise ? kept.ratePerKmPaise : ratePerKmPaise;
  if (mode === "own_vehicle" && !rate) return fieldErr("km", "No approved ₹/KM rate yet — an admin sets it in ERP settings");
  const other = paise(h.otherCost) ?? 0;
  if (other < 0) return fieldErr("otherCost", "Other cost cannot be below 0.");
  const transport = transportCostPaise({ mode, billedPaise: billed, km, ratePerKmPaise: rate }) ?? 0;
  return {
    ok: true,
    data: {
      transportMode: mode,
      transportCostPaise: transport,
      km: mode === "own_vehicle" ? km : null,
      ratePerKmPaise: rate,
      tempoNumber: mode === "none" ? null : tempo,
      otherCostPaise: other,
      otherCostNote: other ? text(h.otherNote) : null,
    },
  };
}

/** How long a PO received in full still takes a late truck at the gate. */
const LATE_TRUCK_DAYS = 30;

/**
 * What can be received, as the forms pick it: every PO that is approved and
 * not yet fully received, by label, with its lines — and, so a late truck is
 * never turned away, a PO received in full in the last month, whose goods then
 * arrive as an extra on it. The server reads the same labels back, so a PO
 * that stopped being receivable while the form was open is refused rather
 * than guessed at.
 */
async function receivable(money = false, include: string[] = []) {
  const [open, late, kept] = await Promise.all([
    purchaseOrderViews({ status: RECEIVABLE_PO }),
    purchaseOrderViews({ status: ["Received"], updatedSince: new Date(Date.now() - LATE_TRUCK_DAYS * 86_400_000) }),
    /* An edit offers the PO a line already sits on, whatever has happened to that PO since. */
    include.length ? purchaseOrderViews({ ids: include }) : Promise.resolve([] as PoView[]),
  ]);
  const listed = new Set([...open, ...late].map((p) => p.po.id));
  const pos = [...open, ...late, ...kept.filter((p) => !listed.has(p.po.id))];
  const byLabel = new Map<string, PoView>(pos.map((p) => [poOption(p), p]));
  const linesBy: Record<string, string[]> = {};
  const typeOf: Record<string, string> = {};
  const itemOf: Record<string, string> = {};
  const pendingOf: Record<string, string> = {};
  const pendingQtyOf: Record<string, number> = {};
  const rateOf: Record<string, string> = {};
  const qtyOf: Record<string, string> = {};
  const supplierOf: Record<string, string> = {};
  const godownOf: Record<string, string> = {};
  /* The same open lines, by the item they bring: the receipt is searched by what arrived. */
  const openByItem = new Map<string, GrnPoLine[]>();
  const doneByItem = new Map<string, GrnPoLine[]>();
  /* A PO line by its id, as the form names it — what Goods in's Receive starts a GRN on. */
  const keyOfLine = new Map<string, { po: string; poLine: string; item: string }>();
  for (const [label, p] of byLabel) {
    godownOf[label] = p.godown;
    supplierOf[label] = `${p.supplier} · deliver to ${p.godown} by ${fd(p.po.deliveryDate)}`;
    linesBy[label] = p.lines.map((l) => l.label);
    for (const l of p.lines) {
      const key = `${label}|${l.label}`;
      keyOfLine.set(l.id, { po: label, poLine: l.label, item: l.item });
      typeOf[key] = l.itemType;
      itemOf[key] = l.item;
      const left = Math.max(0, Math.round((l.expected - l.received) * 1000) / 1000);
      pendingQtyOf[key] = Math.round((l.expected - l.received) * 1000) / 1000;
      rateOf[key] = money ? `${inrRate(l.ratePaise)} per ${l.unit === "Pcs" ? "piece" : l.unit.toLowerCase()}` : "";
      qtyOf[key] = left > 0 ? String(left) : "";
      const entry = { po: label, poLine: l.label, poNumber: poName(p.po), supplier: p.supplier, godown: p.godown, due: p.po.deliveryDate ?? null, ordered: l.expected, received: l.received, pending: left, unit: l.unit };
      if (left > 0) (openByItem.get(l.item) ?? openByItem.set(l.item, []).get(l.item)!).push(entry);
      else (doneByItem.get(l.item) ?? doneByItem.set(l.item, []).get(l.item)!).push(entry);
      const corrected = l.expected !== l.quantity ? ` (ordered ${nf(l.quantity)}, corrected to ${nf(l.expected)})` : "";
      pendingOf[key] = left > 0
        ? `Ordered ${nf(l.expected)} ${l.unit}${corrected} · received ${nf(l.received)} · pending ${nf(left)} ${l.unit}`
        : `Received in full: ${nf(l.received)} of ${nf(l.expected)} ${l.unit}${corrected}. Anything more is added to the PO as an extra.`;
    }
  }
  /* A PO named by its label as the form picks it, or by its bare number as somebody typed it. */
  const find = (typedOrLabel: string | null | undefined): PoView | undefined => {
    const t = (typedOrLabel ?? "").trim();
    if (!t) return undefined;
    const hit = byLabel.get(t);
    if (hit) return hit;
    const n = normalisePoNo(t);
    return pos.find((p) => normalisePoNo(poName(p.po)) === n);
  };
  for (const [k, v] of openByItem) openByItem.set(k, sortPoLines(v));
  /* A line received in full is offered after every open one, for a late truck, and never ahead of them. */
  for (const [k, v] of doneByItem) openByItem.set(k, [...(openByItem.get(k) ?? []), ...sortPoLines(v)]);
  return { pos, byLabel, find, linesBy, typeOf, itemOf, pendingOf, pendingQtyOf, rateOf, qtyOf, supplierOf, godownOf, openByItem, keyOfLine };
}

/**
 * EXPECTED AT THE GATE: every line of an approved, sent or part-received PO
 * that still has goods to come, in the gate's order (`expectedAtGate`). What
 * has arrived is READ (`receivedByLine`), against what the line now expects.
 */
async function gateRows(day: string): Promise<GateRow[]> {
  const pos = await purchaseOrderViews({ status: RECEIVABLE_PO });
  const lines: GateLine[] = pos.flatMap((p) =>
    p.lines.map((l) => ({
      lineId: l.id,
      poId: p.po.id,
      po: poName(p.po),
      supplier: p.supplier,
      supplierId: p.po.supplierId,
      godown: p.godown,
      item: l.item,
      type: l.itemType,
      unit: l.unit,
      expected: l.expected,
      received: l.received,
      due: p.po.deliveryDate ?? null,
      ratePaise: l.ratePaise,
      gstBp: l.gstBp,
    })),
  );
  return expectedAtGate(lines, day);
}

/**
 * The GRN started from Goods in's Expected at the gate: the item-first receipt
 * with these PO lines already on it — one line (Receive), or every open line of
 * that line's supplier at its godown (Receive from <supplier>): one GRN is one
 * supplier's delivery. Null where the line has nothing left to come.
 */
async function gateReceiptForm(ctx: ErpContext, lineId: string, whole: boolean): Promise<FormSpec | null> {
  const rows = await gateRows(today());
  const at = rows.find((r) => r.lineId === lineId);
  if (!at) return null;
  const picked = whole ? supplierDelivery(rows, at) : [at];
  return inwardForm(ctx, { godown: at.godown }, { start: picked.map((r) => r.lineId) });
}

async function inwardForm(ctx: ErpContext, init?: Record<string, string>, opts: { poId?: string; fixed?: boolean; start?: string[] } = {}): Promise<FormSpec> {
  const [gds, config, types] = await Promise.all([godownOptions(ctx, { lost: false }), getConfig(), refValues("materialType")]);
  const all = await db.select().from(erpRawMaterials);
  const rx = await receivable(ctx.powers.has("viewPurchaseMoney"));
  const unitOf: Record<string, string> = {};
  const unitIs: Record<string, string[]> = {};
  /* "scale": a kg chemical, netted off the scale; "typed": measured or counted. */
  const qtyBy: Record<string, string[]> = {};
  const testsOf: Record<string, string[]> = {};
  all.forEach((m) => {
    unitOf[m.name] = m.materialType === "Box" ? "Pcs" : m.unit;
    unitIs[m.name] = [m.unit];
    qtyBy[m.name] = [m.materialType === "Chemical" && m.unit === "Kg" ? "scale" : "typed"];
    testsOf[m.name] = m.testingList;
  });
  const fixedPo = opts.poId ? rx.pos.find((p) => p.po.id === opts.poId) : undefined;
  const poInit = fixedPo ? poOption(fixedPo) : (init?.po ?? "");
  const initLines = fixedPo
    ? fixedPo.lines
        .filter((l) => l.received < l.expected)
        .map((l) => {
          const key = `${poInit}|${l.label}`;
          return { poLine: l.label, type: rx.typeOf[key], item: rx.itemOf[key], qty: qtyBy[l.item]?.[0] === "typed" ? rx.qtyOf[key] : "" };
        })
    : undefined;
  const itemMap = itemsByType(all.filter((m) => m.active || Object.values(rx.itemOf).includes(m.name)), types);
  /* Every active item, with the open PO lines it can be received against — an item with none is listed and refused, never hidden. */
  const grn: GrnItem[] = all
    .filter((m) => m.active || rx.openByItem.has(m.name))
    .map((m) => ({ item: m.name, type: m.materialType, code: m.code, unit: unitOf[m.name], lines: rx.openByItem.get(m.name) ?? [] }));
  const itemFirst = !fixedPo && !opts.fixed && !init?.poFixed;
  return {
    screen: "inward",
    id: "new",
    title: fixedPo ? `Receive goods · ${poName(fixedPo.po)}` : "Goods receipt (GRN)",
    sub: itemFirst ? "Search the item that came in. Its PO follows from it." : "Against a PO, one line per item that arrived.",
    ...(itemFirst ? { flow: "grn" as const } : {}),
    submit: "Save receipt",
    lineLabel: "Item",
    init: {
      date: today(),
      godown: fixedPo?.godown ?? ctx.workingGodown?.name ?? "",
      ...init,
      po: poInit,
      ...(fixedPo || opts.fixed ? { poFixed: poInit } : {}),
    },
    initLines: initLines?.length ? initLines : undefined,
    data: {
      unitOf,
      unitIs,
      qtyBy,
      testsOf,
      ratePerKmPaise: config["erp.purchase.ownVehicleRatePerKmPaise"],
      supplierOf: rx.supplierOf,
      pendingOf: rx.pendingOf,
      pendingQtyOf: rx.pendingQtyOf,
      rateOf: rx.rateOf,
      ...(itemFirst ? { grn } : {}),
      /* Started on PO lines from Expected at the gate: the receipt opens on Receipt details with them on it. */
      ...(itemFirst && opts.start?.length ? { grnStart: opts.start.map((id) => rx.keyOfLine.get(id)).filter((x): x is { po: string; poLine: string; item: string } => !!x) } : {}),
    },
    header: [
      { k: "pr", l: "PR number", t: "derived", calc: "inward.pr" },
      {
        k: "po",
        l: "Purchase order",
        t: "select",
        req: true,
        typed: "Type the PO number",
        opts: poInit && !rx.byLabel.has(poInit) ? [...rx.byLabel.keys(), poInit] : [...rx.byLabel.keys()],
        readOnly: !!(fixedPo || opts.fixed),
        hint: rx.byLabel.size
          ? "Type the PO number — from the Quotation manager or created on a requirement; the supplier and items fill in. No goods are received without a PO."
          : "No PO is waiting for goods. Link one from the Quotation manager or create one on a requirement.",
      },
      { k: "supplier", l: "Supplier", t: "derived", calc: "inward.supplier" },
      { k: "date", l: "Date received", t: "date", req: true },
      godownField(gds, { fillBy: { by: ["po"], map: rx.godownOf }, hint: "The PO's deliver-to godown, unless the goods came somewhere else." }),
      ...COST_FIELDS,
    ],
    line: [
      { k: "poLine", l: "PO item", t: "select", req: true, optsBy: { by: "po", map: rx.linesBy } },
      { k: "type", l: "Material type", t: "select", req: true, readOnly: true, opts: types, fillBy: { by: ["po", "poLine"], map: rx.typeOf }, when: { k: "poLine", notEmpty: true } },
      { k: "item", l: "Item", t: "select", req: true, readOnly: true, optsBy: { by: "type", map: itemMap }, fillBy: { by: ["po", "poLine"], map: rx.itemOf }, when: { k: "type", notEmpty: true } },
      { k: "pending", l: "Against the PO", t: "derived", calc: "inward.pending", when: { k: "poLine", notEmpty: true } },
      { k: "drums", l: "Drums", t: "num", req: true, min: 0, when: { k: "type", eq: "Chemical" }, qtyUnit: { base: "drums" } },
      /* A kg item is weighed on the drum; a litre item is measured, so the gross weight is optional there. */
      { k: "weight", l: "Weight with drum (kg)", t: "num", min: 0, when: { k: "type", eq: "Chemical" }, reqWhen: { k: "item", map: "unitIs", has: "Kg" } },
      { k: "emptyDrum", l: "Empty drum weight (kg, per drum)", t: "num", qtyUnit: { base: "Kg" }, min: 0, when: { k: "type", eq: "Chemical" }, reqWhen: { k: "item", map: "unitIs", has: "Kg" } },
      /* Whose the drums are decides where they go once emptied: our scrap, or back to the supplier. */
      { k: "drumOwner", l: "Drums belong to", t: "select", opts: DRUM_OWNER_OPTS, def: DRUM_OWNER_OPTS[0], when: { k: "type", eq: "Chemical" }, hint: "Returnable drums go back to the supplier once empty and are never sold as scrap." },
      /* A kg chemical's net is the scale's answer, never typed; anything measured or counted is typed. */
      { k: "net", l: "Weight without drum", t: "derived", calc: "inward.net", when: { k: "item", map: "qtyBy", has: "scale" } },
      { k: "qty", l: "Quantity received", t: "num", req: true, min: 0.001, qtyUnit: { by: ["item"], map: unitOf }, when: { k: "item", map: "qtyBy", has: "typed" }, fillBy: { by: ["po", "poLine"], map: rx.qtyOf }, hint: "Starts at what is pending on the PO — type what actually arrived." },
      /* Whatever arrived is received; a difference corrects the PO with a line under this one (0357). */
      { k: "diff", l: "Against the PO", t: "derived", calc: "inward.diff", when: { calc: "inward.gap" } },
      { k: "extra", l: "The extra", t: "select", opts: [...EXTRA_OPTS], def: EXTRA_OPTS[0], untagged: true, when: { calc: "inward.isMore" } },
      { k: "short", l: "Is more coming?", t: "select", opts: [...SHORT_OPTS], def: SHORT_OPTS[0], untagged: true, when: { calc: "inward.isLess" } },
      { k: "unit", l: "Unit", t: "derived", calc: "inward.unit" },
      { k: "testing", l: "Testing required", t: "derived", calc: "inward.testing" },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

/** "Receive goods" on a PO: the receipt form, the PO fixed and its pending items already on it. */
export async function inwardFormForPo(ctx: ErpContext, poId: string): Promise<FormSpec | null> {
  const [p] = await purchaseOrderViews({ ids: [poId] });
  if (!p || !RECEIVABLE_PO.includes(p.po.status)) return null;
  return inwardForm(ctx, undefined, { poId });
}

/* ---------------------------------------------------------------------------
 * A RECEIPT CAN BE CORRECTED AT ANY TIME, and the correction travels. A saved
 * line has usually gone on already, to Lot testing or to Purchases and from
 * there into stock, so only what THIS edit changed is written onward: a remark
 * or a quantity somebody corrected in Purchases is left alone unless this line's
 * own figure moved. The PR stays as it is (the system's number). The PO line —
 * and with it the supplier and the item — moves only through `retargetReceipt`,
 * which works the lot number out again.
 *
 * Nothing refuses a line whose lot has been used. That was asked for: a late
 * correction can leave a lot's stock short, and the audit row says who did it.
 * ------------------------------------------------------------------------- */

type InwardRow = typeof erpInward.$inferSelect;
type InwardChange = Pick<InwardRow, "receivedDate" | "godownId" | "drums" | "weightWithDrum" | "emptyDrumWeight" | "quantity" | "drumOwnership" | "remark">;

async function writeInwardChange(tx: Tx, ctx: ErpContext, r: InwardRow, next: InwardChange): Promise<void> {
  const moved = <K extends keyof InwardChange>(k: K) => (next[k] ?? null) !== (r[k] ?? null);
  const stamp = { updatedAt: new Date(), updatedById: ctx.user.id };
  await tx.update(erpInward).set({ ...next, ...stamp }).where(eq(erpInward.id, r.id));

  const shared = {
    ...(moved("godownId") ? { godownId: next.godownId } : {}),
    ...(moved("quantity") ? { quantity: next.quantity } : {}),
    ...(moved("drums") ? { drums: next.drums } : {}),
    ...(moved("weightWithDrum") ? { weightWithDrum: next.weightWithDrum } : {}),
  };
  if (Object.keys(shared).length) await tx.update(erpTests).set({ ...shared, ...stamp }).where(eq(erpTests.inwardId, r.id));

  /* A tested line's register row names the test as well as, or instead of, this line. */
  const tests = await tx.select({ id: erpTests.id }).from(erpTests).where(eq(erpTests.inwardId, r.id));
  const lots = await tx
    .select({ id: erpPurchases.id, source: erpPurchases.source })
    .from(erpPurchases)
    .where(tests.length ? or(eq(erpPurchases.inwardId, r.id), inArray(erpPurchases.testId, tests.map((t) => t.id))) : eq(erpPurchases.inwardId, r.id));
  for (const lot of lots) {
    const onward = {
      ...shared,
      /* A tested lot is dated by its test, not by the day the goods came in. */
      ...(moved("receivedDate") && lot.source === "inward" ? { purchaseDate: next.receivedDate } : {}),
      ...(moved("remark") ? { remark: next.remark } : {}),
    };
    if (!Object.keys(onward).length) continue;
    await tx.update(erpPurchases).set({ ...onward, ...stamp }).where(eq(erpPurchases.id, lot.id));
    await refreshCache(tx, lot.id);
    await syncPurchaseEntry(tx, lot.id);
  }
  if (moved("quantity")) await refreshPurchaseOrder(tx, r.poId);
}

/* ---------------------------------------------------------------------------
 * MOVING RECEIVED GOODS TO ANOTHER PO LINE, SUPPLIER OR ITEM (Nov 2026: the
 * owner asked for full edit everywhere in purchase, except what the system
 * generates). The goods stay received; what they were received AGAINST
 * changes, and every record that copied it follows in one transaction: the
 * inward line, its tests, its register lots and the stock entries those
 * posted. The lot number is built from the supplier, the item and the PR, so
 * it is worked out again here, never typed.
 *
 * One thing holds it: a lot something else already names — moved, used in a
 * batch, returned, its drums recorded, adjusted. Those records carry the old
 * lot number, and renumbering under them would leave stock that adds up
 * nowhere. Counts and stock checks do not hold it: they read the item, not
 * the lot, and the audit row says who moved it.
 * ------------------------------------------------------------------------- */

/** Where a receipt should now sit: a PO line, and the supplier (the PO's, unless a PO edit is changing it). */
export type ReceiptTarget = { poLineId: string; supplierId?: string };

/**
 * Moves one receipt — an inward line, or a register lot entered by hand — to
 * `to`. Inside the caller's transaction; refuses (throws) when a lot it would
 * renumber is already in use. Returns the PO ids touched, so the caller
 * refreshes each once.
 */
export async function retargetReceipt(tx: Tx, ctx: ErpContext, from: { inwardId?: string | null; purchaseId?: string | null }, to: ReceiptTarget): Promise<string[]> {
  const [line] = await tx
    .select({ l: erpPoLines, poNumber: erpPurchaseOrders.poNumber, poSupplier: erpPurchaseOrders.supplierId })
    .from(erpPoLines)
    .innerJoin(erpPurchaseOrders, eq(erpPurchaseOrders.id, erpPoLines.poId))
    .where(eq(erpPoLines.id, to.poLineId));
  if (!line) return refuse(err("That PO item no longer exists.", "not_found"));
  const supplierId = to.supplierId ?? line.poSupplier;
  const [sup] = await tx.select().from(erpSuppliers).where(eq(erpSuppliers.id, supplierId));
  const [mat] = await tx.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, line.l.rawMaterialId));
  if (!sup || !mat) return refuse(err("The supplier or the item no longer exists.", "not_found"));
  const stamp = { updatedAt: new Date(), updatedById: ctx.user.id };
  const touched = new Set<string>([line.l.poId]);

  let inward: InwardRow | undefined;
  if (from.inwardId) [inward] = await tx.select().from(erpInward).where(eq(erpInward.id, from.inwardId)).for("update");
  else if (from.purchaseId) {
    const [p] = await tx.select({ inwardId: erpPurchases.inwardId, testId: erpPurchases.testId }).from(erpPurchases).where(eq(erpPurchases.id, from.purchaseId));
    const viaTest = !p?.inwardId && p?.testId ? (await tx.select({ id: erpTests.inwardId }).from(erpTests).where(eq(erpTests.id, p.testId)))[0]?.id : null;
    const inwardId = p?.inwardId ?? viaTest;
    if (inwardId) [inward] = await tx.select().from(erpInward).where(eq(erpInward.id, inwardId)).for("update");
  }

  const tests = inward ? await tx.select({ id: erpTests.id }).from(erpTests).where(eq(erpTests.inwardId, inward.id)) : [];
  const lots = inward
    ? await tx.select().from(erpPurchases).where(tests.length ? or(eq(erpPurchases.inwardId, inward.id), inArray(erpPurchases.testId, tests.map((t) => t.id))) : eq(erpPurchases.inwardId, inward.id))
    : from.purchaseId
      ? await tx.select().from(erpPurchases).where(eq(erpPurchases.id, from.purchaseId))
      : [];

  if (inward) {
    if (inward.poId) touched.add(inward.poId);
    const moved = inward.poLineId !== line.l.id;
    await tx
      .update(erpInward)
      .set({ poId: line.l.poId, poLineId: line.l.id, supplierId: sup.id, rawMaterialId: mat.id, materialType: mat.materialType, unit: mat.materialType === "Box" ? "Pcs" : mat.unit, ...stamp })
      .where(eq(erpInward.id, inward.id));
    if (tests.length) await tx.update(erpTests).set({ rawMaterialId: mat.id, supplierId: sup.id, ...stamp }).where(inArray(erpTests.id, tests.map((t) => t.id)));
    /* What this line corrected on its old PO line no longer stands there: struck through with the reason, as a void does. */
    if (moved) {
      const live = await tx.select({ id: erpPoCorrections.id }).from(erpPoCorrections).where(and(eq(erpPoCorrections.inwardId, inward.id), isNull(erpPoCorrections.cancelledAt)));
      if (live.length) {
        await tx
          .update(erpPoCorrections)
          .set({ cancelledAt: new Date(), cancelledById: ctx.user.id, cancelReason: `GRN line moved to ${poLabel(line.poNumber)}` })
          .where(inArray(erpPoCorrections.id, live.map((c) => c.id)));
        if (inward.poId) await tx.update(erpPurchaseOrders).set({ revision: sql`${erpPurchaseOrders.revision} + 1`, ...stamp }).where(eq(erpPurchaseOrders.id, inward.poId));
      }
    }
  }

  for (const lot of lots) {
    if (lot.poId) touched.add(lot.poId);
    const lotNo = lotNumber(sup.partyCode, mat.code, lot.prNumber);
    if (lotNo !== lot.lotNo || lot.rawMaterialId !== mat.id) {
      await lockLot(tx, "rm", lot.lotNo, lot.godownId);
      const [g] = await tx.select({ name: erpGodowns.name }).from(erpGodowns).where(eq(erpGodowns.id, lot.godownId));
      const [was] = await tx.select({ name: erpRawMaterials.name }).from(erpRawMaterials).where(eq(erpRawMaterials.id, lot.rawMaterialId));
      const use = await lotUseBlocker(tx, lot, was?.name ?? "The item", g?.name ?? "its godown", false);
      if (use) return refuse(err(`${use} Its lot number is on that record, so the supplier or item cannot change under it — undo that first, or correct the stock with an adjustment.`, "rule_violation"));
      if (lotNo !== lot.lotNo) {
        const [clash] = await tx.select({ id: erpPurchases.id }).from(erpPurchases).where(and(eq(erpPurchases.lotNo, lotNo), sql`${erpPurchases.id} <> ${lot.id}`));
        if (clash) return refuse(err(`Lot ${lotNo} already exists — PR ${lot.prNumber} already has ${mat.name} from ${sup.name}.`, "conflict"));
      }
    }
    await tx
      .update(erpPurchases)
      .set({ supplierId: sup.id, rawMaterialId: mat.id, lotNo, poId: line.l.poId, poLineId: line.l.id, poNumber: poLabel(line.poNumber), ...stamp })
      .where(eq(erpPurchases.id, lot.id));
    await refreshCache(tx, lot.id);
    await syncPurchaseEntry(tx, lot.id);
  }
  return [...touched];
}

/** A PO line's label as the receipt forms pick it — "Toluene · 200 Kg" — from the receivable list, for an edit form's init. */
function poLineLabelOf(rx: Awaited<ReturnType<typeof receivable>>, poId: string | null, poLineId: string | null): { po: string; poLine: string } {
  const p = poId ? rx.pos.find((x) => x.po.id === poId) : undefined;
  const l = p?.lines.find((x) => x.id === poLineId);
  return { po: p ? poOption(p) : "", poLine: l?.label ?? "" };
}

/* ------------------------------------------------------- voiding a line */

/** Voiding takes stock out of the book, so it is a stock-control decision: an ERP manager, or the stock-control power. */
export const mayVoidInward = (ctx: ErpContext) => ctx.administrator || ctx.level === "manager" || ctx.powers.has("stockControl");
export const VOID_WHY = "Voiding a received line needs an ERP manager or the stock-control power.";

/**
 * WHAT VOIDING A MISTAKEN INWARD LINE TAKES WITH IT, and why it cannot — one
 * reading for the impact modal and for the act, which reads it again under a
 * lock on each lot. A line goes only while nothing has come of it but its own
 * records: its register lot (and the stock entry that lot posted), its
 * not-yet-verified test, and the PO corrections it made. Anything that READ
 * the lot as stock — a transfer, an SFG batch, a vendor return, an empty drum,
 * a count, a stock check or an adjustment — or a supplier bill recorded
 * against it, or a verified test, holds it: those are decisions made on the
 * line being real, and are corrected where they were made.
 */
export type InwardVoidPicture = {
  r: InwardRow;
  item: string;
  supplier: string;
  godown: string;
  poNumber: number | null;
  tests: { id: string; status: string }[];
  lots: { id: string; lotNo: string; quantity: number; unit: string; posted: boolean; status: string; billReceived: string | null }[];
  corrections: { id: string; kind: string; quantity: number }[];
  /** Other lines on the same PR, which stay. */
  siblings: number;
  blocker: string | null;
};

/**
 * WHAT HAS ALREADY READ A LOT AS STOCK: a transfer, an SFG batch, a vendor
 * return, an empty drum, an adjustment, or a count or stock check made after it
 * arrived. Null when nothing has. Voiding a line and moving a line to another
 * item or supplier (which renumbers its lot) both stop on it, because those
 * records name the lot as it was.
 */
export async function lotUseBlocker(
  ex: Tx | typeof db,
  l: { id: string; lotNo: string; rawMaterialId: string; godownId: string; createdAt: Date },
  item: string,
  godown: string,
  /** A count since the lot arrived holds a void; a move keeps the stock, so only what names the lot holds it. */
  withCounts = true,
): Promise<string | null> {
  const [use] = (await ex.execute(sql`
      select why from (
        select 1 as o, 'Lot ' || ${l.lotNo} || ' has been moved to another godown since it arrived.' as why
          from erp_transfers where item_type = 'Purchase' and lot_no = ${l.lotNo}
        union all
        select 2, 'Lot ' || ${l.lotNo} || ' has been used in an SFG batch.' from erp_sfg_lines where rm_lot_no = ${l.lotNo}
        union all
        select 3, 'Lot ' || ${l.lotNo} || ' has a return to the supplier against it.' from erp_purchase_returns where purchase_id = ${l.id}
        union all
        select 4, 'Empty drums of lot ' || ${l.lotNo} || ' have been recorded.' from erp_empty_drums where purchase_id = ${l.id} and status <> 'cancelled'
        union all
        select 5, 'Lot ' || ${l.lotNo} || ' was adjusted on Stock on hand.' from erp_manual_adjustments where stage = 'rm' and lot = ${l.lotNo}
        union all
        select 6, ${item} || ' was counted at ' || ${godown} || ' after this delivery, against a book that includes it.'
          from erp_stock_counts c where c.raw_material_id = ${l.rawMaterialId} and c.godown_id = ${l.godownId} and c.counted_at > ${l.createdAt.toISOString()}::timestamptz and c.status <> 'cancelled' and ${withCounts}
        union all
        select 7, ${item} || ' was stock-checked at ' || ${godown} || ' after this delivery, against a book that includes it.'
          from erp_floor_checks f where f.stage = 'rm' and f.item_id = ${l.rawMaterialId} and f.godown_id = ${l.godownId} and f.counted_at > ${l.createdAt.toISOString()}::timestamptz and ${withCounts}
      ) u order by o limit 1`)) as unknown as { why: string }[];
  return use?.why ?? null;
}

export async function inwardVoidPicture(ex: Tx | typeof db, id: string): Promise<InwardVoidPicture | null> {
  const [x] = await ex
    .select({ r: erpInward, item: erpRawMaterials.name, supplier: erpSuppliers.name, godown: erpGodowns.name, poNumber: erpPurchaseOrders.poNumber })
    .from(erpInward)
    .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpInward.rawMaterialId))
    .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpInward.supplierId))
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpInward.godownId))
    .leftJoin(erpPurchaseOrders, eq(erpPurchaseOrders.id, erpInward.poId))
    .where(eq(erpInward.id, id));
  if (!x) return null;
  const tests = await ex.select({ id: erpTests.id, status: erpTests.status }).from(erpTests).where(eq(erpTests.inwardId, id));
  const lotRows = await ex
    .select()
    .from(erpPurchases)
    .where(tests.length ? or(eq(erpPurchases.inwardId, id), inArray(erpPurchases.testId, tests.map((t) => t.id))) : eq(erpPurchases.inwardId, id));
  const posted = lotRows.length
    ? await ex.select({ sourceId: erpRmEntries.sourceId }).from(erpRmEntries).where(and(eq(erpRmEntries.sourceType, "purchase"), inArray(erpRmEntries.sourceId, lotRows.map((l) => l.id))))
    : [];
  const corrections = await ex
    .select({ id: erpPoCorrections.id, kind: erpPoCorrections.kind, quantity: erpPoCorrections.quantity })
    .from(erpPoCorrections)
    .where(and(eq(erpPoCorrections.inwardId, id), isNull(erpPoCorrections.cancelledAt)));
  const [{ n: siblings }] = (await ex.execute(sql`select count(*)::int as n from erp_inward where pr_number = ${x.r.prNumber} and id <> ${id}`)) as unknown as { n: number }[];
  const out: InwardVoidPicture = {
    r: x.r,
    item: x.item,
    supplier: x.supplier,
    godown: x.godown,
    poNumber: x.poNumber ?? null,
    tests,
    lots: lotRows.map((l) => ({ id: l.id, lotNo: l.lotNo, quantity: Number(l.availableLitres ?? l.quantity), unit: l.unit, posted: posted.some((p) => p.sourceId === l.id), status: l.status, billReceived: l.billReceived })),
    corrections: corrections.map((c) => ({ ...c, quantity: Number(c.quantity) })),
    siblings: Number(siblings),
    blocker: null,
  };
  const verified = tests.find((t) => t.status === "Verified");
  if (verified) return { ...out, blocker: `The test on this line is verified. Mark it Not Verified on Lot testing first, if the delivery itself was the mistake.` };
  for (const l of lotRows) {
    if (l.status !== "Pending" || l.billReceived === "Received")
      return { ...out, blocker: `The supplier's bill is recorded against lot ${l.lotNo} (${l.status}). Undo the bill on the purchase register first.` };
    const use = await lotUseBlocker(ex, l, x.item, x.godown);
    if (use) return { ...out, blocker: `${use} Correct it with a stock adjustment instead of voiding the delivery.` };
  }
  return out;
}

/**
 * VOIDING A MISTAKEN INWARD LINE, in one transaction: its register lot and the
 * stock entry that lot posted go (so the stock it added is gone), its
 * unverified test goes, the PO corrections it made are cancelled with the
 * reason and stay struck through, and the PO's received figure and status
 * are worked out again from what is left. The audit row keeps all of it as it
 * stood. Anything that already used the lot refuses it (`inwardVoidPicture`).
 */
async function voidInward(ctx: ErpContext, id: string, values: Record<string, string>): Promise<Result<unknown>> {
  const reason = text(values.reason);
  if (!reason || reason.length < 5) return fieldErr("reason", "Say why this line is void — it is kept with the record.");
  const refusal = await confirmImpact("erp-inward-void", id, readConfirmation(values));
  if (refusal) return refusal;
  const seen: { p?: InwardVoidPicture } = {};
  const res = await inTx(async (tx) => {
    const [row] = await tx.select().from(erpInward).where(eq(erpInward.id, id)).for("update");
    if (!row) return refuse(err("That line no longer exists.", "not_found"));
    const first = await inwardVoidPicture(tx, id);
    for (const l of first?.lots ?? []) await lockLot(tx, "rm", l.lotNo, row.godownId);
    const p = await inwardVoidPicture(tx, id);
    if (!p) return refuse(err("That line no longer exists.", "not_found"));
    if (p.blocker) return refuse(err(p.blocker, "rule_violation"));
    seen.p = p;
    const lotIds = p.lots.map((l) => l.id);
    if (lotIds.length) {
      await tx.delete(erpRmEntries).where(and(eq(erpRmEntries.sourceType, "purchase"), inArray(erpRmEntries.sourceId, lotIds)));
      await tx.delete(erpPurchases).where(inArray(erpPurchases.id, lotIds));
    }
    if (p.tests.length) await tx.delete(erpTests).where(inArray(erpTests.id, p.tests.map((t) => t.id)));
    if (p.corrections.length) {
      await tx
        .update(erpPoCorrections)
        .set({ cancelledAt: new Date(), cancelledById: ctx.user.id, cancelReason: `GRN line voided: ${reason}` })
        .where(inArray(erpPoCorrections.id, p.corrections.map((c) => c.id)));
      if (row.poId) await tx.update(erpPurchaseOrders).set({ revision: sql`${erpPurchaseOrders.revision} + 1`, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchaseOrders.id, row.poId));
    }
    await tx.delete(erpInward).where(eq(erpInward.id, id));
    await refreshPurchaseOrder(tx, row.poId);
    return okVoid(`PR ${row.prNumber} · ${p.item} voided${lotIds.length ? ` · lot ${p.lots.map((l) => l.lotNo).join(", ")} taken out of stock` : ""}`);
  });
  if (res.ok && seen.p)
    await erpAudit(ctx, "erp.inward.void", "erp_inward", id, { line: seen.p.r, lots: seen.p.lots, tests: seen.p.tests, corrections: seen.p.corrections }, { reason });
  return res;
}

async function inwardEditForm(ctx: ErpContext, id: string): Promise<FormSpec | null> {
  const [x] = await db
    .select({ r: erpInward, item: erpRawMaterials.name, unit: erpRawMaterials.unit, godown: erpGodowns.name })
    .from(erpInward)
    .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpInward.rawMaterialId))
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpInward.godownId))
    .where(eq(erpInward.id, id));
  if (!x) return null;
  const [gds, rx] = await Promise.all([godownOptions(ctx, { lost: false }), receivable(ctx.powers.has("viewPurchaseMoney"), x.r.poId ? [x.r.poId] : [])]);
  const at = poLineLabelOf(rx, x.r.poId, x.r.poLineId);
  const chemical = x.r.materialType === "Chemical";
  const scale = chemical && x.unit === "Kg";
  const own = x.r.drumOwnership as "mahek" | "returnable" | null;
  return {
    screen: "inward",
    id: "edit",
    recordId: id,
    title: `Edit PR ${x.r.prNumber} · ${x.item}`,
    sub: x.r.routed ? `Already sent to ${x.r.routed}: a change here carries over to it and to stock.` : undefined,
    submit: "Save line",
    data: { supplierOf: rx.supplierOf, pendingOf: rx.pendingOf },
    init: {
      ...at,
      item: x.item,
      date: x.r.receivedDate,
      godown: x.godown,
      drums: x.r.drums == null ? "" : String(x.r.drums),
      weight: x.r.weightWithDrum == null ? "" : String(x.r.weightWithDrum),
      emptyDrum: x.r.emptyDrumWeight == null ? "" : String(x.r.emptyDrumWeight),
      drumOwner: own ? OWNERSHIP_LABEL[own] : DRUM_OWNER_OPTS[0],
      qty: String(x.r.quantity),
      remark: x.r.remark ?? "",
    },
    header: [
      /* The PO and its item can be corrected: the supplier and the item follow the PO line, and the lot is renumbered (`retargetReceipt`). */
      {
        k: "po",
        l: "Purchase order",
        t: "select",
        req: !!x.r.poId,
        opts: [...rx.byLabel.keys()],
        hint: x.r.poId ? "A different PO or item changes the supplier and the item on this line, its test and its lot." : "Received before POs. Pick one to put it on a PO.",
      },
      { k: "poLine", l: "PO item", t: "select", req: !!x.r.poId, optsBy: { by: "po", map: rx.linesBy } },
      { k: "item", l: "Item", t: "select", readOnly: true, opts: [...new Set([x.item, ...Object.values(rx.itemOf)])], fillBy: { by: ["po", "poLine"], map: rx.itemOf } },
      { k: "supplier", l: "Supplier", t: "derived", calc: "inward.supplier" },
      { k: "pending", l: "Against the PO", t: "derived", calc: "register.pending", when: { k: "poLine", notEmpty: true } },
      { k: "date", l: "Date received", t: "date", req: true },
      godownField(gds),
      ...(chemical
        ? ([
            { k: "drums", l: "Drums", t: "num", req: true, min: 0, qtyUnit: { base: "drums" } },
            { k: "weight", l: "Weight with drum (kg)", t: "num", min: 0, req: scale, hint: scale ? "The quantity is worked out from this, less the empty drums." : undefined },
            { k: "emptyDrum", l: "Empty drum weight (kg, per drum)", t: "num", min: 0, req: scale, qtyUnit: { base: "Kg" } },
            { k: "drumOwner", l: "Drums belong to", t: "select", opts: DRUM_OWNER_OPTS },
          ] as FieldSpec[])
        : []),
      ...(scale ? [] : ([{ k: "qty", l: "Quantity received", t: "num", req: true, min: 0.001, qtyUnit: { base: x.r.unit } }] as FieldSpec[])),
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

/** What several lines can share. Quantity and weights belong to one line, so they stay on the row's own Edit. */
function inwardBulkPrompt(form: FormSpec): PromptSpec {
  const godowns = form.header.find((f) => f.k === "godown")?.opts ?? [];
  return {
    title: "Edit selected lines",
    sub: "Blank keeps what each line has. For quantity or weights, use Edit on the line.",
    submit: "Save lines",
    fields: [
      { k: "date", l: "Date received", t: "date" },
      { k: "godown", l: "Godown", t: "select", opts: godowns },
      { k: "drumOwner", l: "Drums belong to", t: "select", opts: DRUM_OWNER_OPTS, hint: "Applies to chemical lines only." },
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

/** The drum owner a form named: the supplier's own where it says to follow the supplier's master. */
async function drumOwnerNamed(label: string | null | undefined, supplierId: string, tx: Tx | typeof db = db): Promise<string | null> {
  const named = ownershipByLabel(label ?? undefined);
  if (named) return named;
  const [sup] = await tx.select({ own: erpSuppliers.drumOwnership }).from(erpSuppliers).where(eq(erpSuppliers.id, supplierId));
  return sup?.own ?? null;
}

/** Goods inward is a register by received date; a line not yet routed is work and always shows. */
const INWARD_WINDOW = { label: "Received date", default: REGISTER_DEFAULT } as const;

const inward: ScreenModule = {
  key: "inward",
  window: INWARD_WINDOW,
  async load(ctx, s) {
    const sc = s ?? unscoped();
    const day = today();
    /* A line not yet routed is work, and today's lines are Received today: both show whatever the period. */
    const where = sc.ids?.length
      ? windowWhere(sql`${erpInward.receivedDate}`, sql`${erpInward.id}`, sc)
      : sql`(${windowWhere(sql`${erpInward.receivedDate}`, sql`${erpInward.id}`, sc)} or ${erpInward.routed} is null or ${erpInward.receivedDate} = ${day}::date)`;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(erpInward).where(where);
    const wide = tooWide(Number(n), sc);
    const rows = await db
      .select({
        r: erpInward,
        supplier: erpSuppliers.name,
        partyCode: erpSuppliers.partyCode,
        item: erpRawMaterials.name,
        itemCode: erpRawMaterials.code,
        godown: erpGodowns.name,
        by: users.name,
        poNumber: erpPurchaseOrders.poNumber,
        qmPoNo: erpPurchaseOrders.qmPoNo,
        poStatus: erpPurchaseOrders.status,
      })
      .from(erpInward)
      .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpInward.supplierId))
      .leftJoin(erpPurchaseOrders, eq(erpPurchaseOrders.id, erpInward.poId))
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpInward.rawMaterialId))
      .innerJoin(erpGodowns, eq(erpGodowns.id, erpInward.godownId))
      .leftJoin(users, eq(users.id, erpInward.createdById))
      .where(wide ? sql`false` : where)
      .orderBy(desc(erpInward.prNumber), asc(erpInward.createdAt));
    const prs = [...new Set(rows.map((x) => x.r.prNumber))];
    const [form, costRows, gate] = await Promise.all([
      inwardForm(ctx),
      prs.length ? db.select().from(erpPrCosts).where(inArray(erpPrCosts.prNumber, prs)) : Promise.resolve([] as (typeof erpPrCosts.$inferSelect)[]),
      /* Expected at the gate is work waiting now: read whole, never through the period (a dashboard's ids name receipts only). */
      sc.ids?.length ? Promise.resolve([] as GateRow[]) : gateRows(day),
    ]);
    const money = ctx.powers.has("viewPurchaseMoney");
    const costs = new Map(costRows.map((c) => [c.prNumber, c]));
    const cols: ColSpec[] = [
      { k: "pr", l: "PR no", t: "mono" },
      { k: "po", l: "PO", t: "mono" },
      { k: "date", l: "Date", t: "d" },
      { k: "supplier", l: "Supplier", t: "t" },
      { k: "type", l: "Material type", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "drums", l: "Drums", t: "n" },
      { k: "weight", l: "Weight with drum", t: "n" },
      { k: "emptyDrum", l: "Empty drum weight", t: "n" },
      { k: "drumOwner", l: "Drums belong to", t: "s" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "transport", l: "Transport", t: "s" },
      { k: "testing", l: "Testing required", t: "s" },
      { k: "routed", l: "Sent to", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    /* EXPECTED AT THE GATE reads PO lines, not receipts: its own columns, grouped by one supplier's delivery to one godown. */
    const gateCols: ColSpec[] = [
      { k: "po", l: "PO", t: "mono", w: 80 },
      { k: "item", l: "Item", t: "b", w: 150 },
      { k: "type", l: "Category", t: "s", w: 100 },
      { k: "ordered", l: "Ordered", t: "n", uk: "unit", w: 110 },
      { k: "receivedQty", l: "Received", t: "n", w: 90 },
      { k: "toCome", l: "Still to come", t: "n", uk: "unit", w: 120 },
      { k: "due", l: "Due", t: "d", late: "late", after: "dueWords", w: 160 },
      { k: "deliverTo", l: "Deliver to", t: "t", w: 100 },
      { k: "supplier", l: "Supplier", t: "t" },
      { k: "group", l: "From", t: "t" },
      { k: "groupLine", l: "", t: "t" },
    ];
    const canReceive = ctx.screens.has("purchaseOrders") || ctx.screens.has("inward");
    const groupLines = new Map<string, string>();
    for (const g of new Set(gate.map((r) => r.group))) groupLines.set(g, gateGroupLine(gate.filter((r) => r.group === g), day, money ? (p) => inr(Math.round(p / 100) * 100) : undefined));
    const expectedRows: ListRow[] = gate.map((r) => {
      const due = deliveryWords(r.due, day, true);
      return {
        id: r.lineId,
        v: {
          kind: "expected",
          po: r.po,
          item: r.item,
          type: r.type,
          ordered: r.expected,
          unit: r.unit,
          receivedQty: r.received,
          toCome: r.toCome,
          due: r.due,
          late: due?.late ? due.words : null,
          dueWords: due && !due.late ? due.words : null,
          deliverTo: r.godown,
          supplier: r.supplier,
          group: r.group,
          groupLine: groupLines.get(r.group) ?? "",
        },
        flags: [...(r.late ? ["lateLine"] : []), ...(r.due === day ? ["gateToday"] : [])],
        title: `${r.item} · ${r.po}`,
        ref: r.po,
        header: `${r.supplier} · deliver to ${r.godown}${r.due ? ` by ${fd(r.due)}${due ? ` (${due.words})` : ""}` : ""} · ${nf(r.toCome)} ${r.unit} still to come`,
        fields: [
          { l: "Ordered", v: `${nf(r.expected)} ${r.unit}`, der: true },
          { l: "Received so far", v: `${nf(r.received)} ${r.unit}`, der: true },
        ],
        actions: [
          /* THE NEXT STEP: the GRN, with this PO line already on it. */
          { id: "receive", l: "Receive", primary: true, loadsForm: true, why: canReceive ? "" : "Goods in is not on your account" },
          /* One GRN for the whole truck: every open line of this supplier at this godown. */
          { id: "receiveAll", l: `Receive from ${r.supplier}`, loadsForm: true, why: canReceive ? "" : "Goods in is not on your account" },
          { id: "openPo", l: `Open ${r.po}`, href: erpLink("purchaseOrders", { open: r.poId }) },
        ],
      };
    });
    /* RECEIVED TODAY: the design's few columns — what came, from whom, where it went. */
    const todayCols: ColSpec[] = [
      { k: "pr", l: "PR", t: "mono", w: 88 },
      { k: "supplierPo", l: "Supplier · PO", t: "t" },
      { k: "item", l: "Item", t: "b" },
      { k: "receivedText", l: "Received", t: "t", w: 160 },
      { k: "routed", l: "Sent to", t: "s" },
      { k: "transport", l: "Transport", t: "s" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "inward",
        cols,
        hidden: [],
        groups: ["pr"],
        /* Three sub-tabs, opening on the work waiting at the gate. Expected at the gate lists PO lines; the other two, receipt lines. */
        subtabs: [
          {
            id: "expected",
            l: "Expected at the gate",
            k: "kind",
            in: ["expected"],
            unwindowed: true,
            hint: "Every PO line still to come, late first",
            line: "A truck arrived? Press Receive from its supplier — every open line of that supplier comes into one GRN. Not listed? Use Receive goods and search the item.",
            view: {
              cols: gateCols,
              groups: ["group"],
              groupHead: ["groupLine"],
              groupHeadStrong: [],
              groupSel: false,
              groupAction: "receiveAll",
              groupNoCount: true,
              bulk: [],
              selectSum: [],
              /* The gate reads the list itself: no figure cards (the design's). */
              stats: [],
              filters: ["supplier", "item", "type", "deliverTo"],
              noDataLine: "Nothing is expected at the gate — every PO with a supplier has arrived",
            },
          },
          {
            id: "today",
            l: "Received today",
            k: "kind",
            in: ["receiptToday"],
            unwindowed: true,
            hint: "What was saved today — still correctable here",
            view: {
              cols: todayCols,
              groups: [],
              stats: [],
              noDataLine: "Nothing received today yet",
            },
          },
          { id: "all", l: "All receipts", k: "kind", in: ["receipt", "receiptToday"] },
        ],
        groupHead: ["po", "date", "supplier", "godown", "transport"],
        groupSel: true,
        godownKey: "godown",
        /* Quantity is not summed: lines mix kg, litres and pieces. */
        stats: [
          { l: "Lines" },
          { l: "PRs", kind: "distinct", k: "pr" },
          { l: "Suppliers", kind: "distinct", k: "supplier" },
          { l: "Drums", kind: "sum", k: "drums", u: "drums" },
          { l: "Not sent on", where: { flag: "awaitingRoute" }, tone: "warn" },
          { l: "Before POs", where: { flag: "noPo" }, tone: "muted" },
        ],
        filters: ["supplier", "type", "item", "testing", "routed", "drumOwner"],
        newForm: form,
        newLabel: "Receive goods",
        /* WHAT A SELECTION CAN DO, BY ITS SHAPE. Sending on and the shared edit
           are line by line, so any selection takes them; Transport & costs is
           once per PR, so it is offered only while the ticks are one PR's lines
           and it opens that PR's own form. */
        bulk: [
          { id: "combined", l: "Combined view", client: "combinedView", fits: false },
          { id: "toTesting", l: "Send to Testing" },
          { id: "toPurchase", l: "Send to Purchase" },
          { id: "editMany", l: "Edit", fits: false, prompt: inwardBulkPrompt(form) },
          { id: "costs", l: "Transport & costs", same: ["pr"], asRow: true },
        ],
        combined: {
          cols: ["pr", "po", "item", "drums", "weight", "qty", "unit", "testing", "routed"],
          facts: ["supplier", "pr", "po", "date", "godown", "transport"],
          totals: [
            { l: "Lines" },
            { l: "PRs", kind: "distinct", k: "pr" },
            { l: "Drums", kind: "sum", k: "drums" },
            { l: "Not sent on", where: { flag: "awaitingRoute" }, tone: "warn" },
            { l: "Before POs", where: { flag: "noPo" }, tone: "muted" },
          ],
          /* kg, litres and pieces do not add, so the net weight is said per unit. */
          sumBy: { k: "qty", by: "unit", l: "Quantity" },
          words: { pr: "PR" },
        },
        noDataLine: "No goods received yet. Goods are received against a PO.",
      },
      tooWide: wide,
      rows: [...expectedRows, ...rows.map((x): ListRow => {
        const actions: ActionSpec[] = [];
        if (!x.r.routed && x.r.testingRequired)
          actions.push({ id: "toTesting", l: "Send to Testing", primary: true });
        if (!x.r.routed && !x.r.testingRequired)
          actions.push({ id: "toPurchase", l: "Send to Purchase", primary: true });
        const poText = x.poNumber == null ? null : `${poLabel(x.poNumber)} · ${x.supplier}`;
        const receivableHere = !!poText && RECEIVABLE_PO.includes(x.poStatus ?? "");
        actions.push({
          id: "addMore",
          l: "Add another item from this truck",
          why: !x.r.poId ? "Received before POs — receive new goods against a PO" : receivableHere ? "" : `${poLabel(x.poNumber!)} is ${x.poStatus} — nothing more is received against it`,
          form: receivableHere
            ? {
                ...form,
                flow: undefined,
                sub: "Against a PO, one line per item that arrived.",
                title: `Add to PR ${x.r.prNumber} · ${poLabel(x.poNumber!)}`,
                initLines: undefined,
                /* The PR's transport is already recorded; "Transport & costs" changes it. The PO is the PR's. */
                header: form.header.filter((f) => !COST_FIELDS.some((c) => c.k === f.k)).map((f) => (f.k === "po" ? { ...f, readOnly: true } : f)),
                init: { ...form.init, pr: String(x.r.prNumber), prFixed: String(x.r.prNumber), date: x.r.receivedDate, godown: x.godown, po: poText!, poFixed: poText! },
              }
            : undefined,
        });
        /* The lot this line is (or, once tested, will be) registered under — traced from here. */
        const lot = lotNumber(x.partyCode, x.itemCode, x.r.prNumber);
        actions.push({ id: "trace", l: "Trace this lot", href: erpTraceHref(lot) });
        actions.push({ id: "edit", l: "Edit receipt line", loadsForm: true });
        actions.push({
          id: "void",
          l: "Void this line…",
          why: mayVoidInward(ctx) ? "" : VOID_WHY,
          prompt: {
            title: `Void ${x.item} on PR ${x.r.prNumber}?`,
            sub: "For a line received in error. The modal that follows says what goes with it; anything that already used the lot stops it.",
            submit: "Next",
            fields: [{ k: "reason", l: "Why is this line void?", t: "area", req: true }],
          },
          impact: { kind: "erp-inward-void", id: x.r.id },
        });
        const c = costs.get(x.r.prNumber);
        actions.push({
          id: "costs",
          l: "Transport & costs",
          form: {
            screen: "inward",
            id: "costs",
            recordId: String(x.r.prNumber),
            title: `Transport & costs · PR ${x.r.prNumber}`,
            sub: "Once per PR. Landing cost = material + transport + other, shared across its items by value.",
            submit: "Save costs",
            data: form.data,
            init: costInit(c),
            header: COST_FIELDS,
          },
        });
        const transport = !c
          ? "Not recorded"
          : [transportModeLabel(c.transportMode), c.transportMode === "none" ? "" : inr(c.transportCostPaise), c.tempoNumber ?? ""].filter(Boolean).join(" · ");
        const poShown = x.poNumber == null ? null : poName({ poNumber: x.poNumber, qmPoNo: x.qmPoNo });
        return {
          id: x.r.id,
          v: {
            /* Today's receipts are Received today and All receipts alike. */
            kind: x.r.receivedDate === day ? "receiptToday" : "receipt",
            pr: String(x.r.prNumber),
            po: poShown,
            supplierPo: [x.supplier, poShown].filter(Boolean).join(" · "),
            receivedText: [`${nf(x.r.quantity)} ${x.r.unit}`, x.r.drums ? `${nf(x.r.drums)} drum${x.r.drums === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "),
            date: x.r.receivedDate,
            supplier: x.supplier,
            type: x.r.materialType,
            item: x.item,
            drums: x.r.drums,
            weight: x.r.weightWithDrum,
            emptyDrum: x.r.emptyDrumWeight,
            drumOwner: x.r.materialType !== "Chemical" ? null : x.r.drumOwnership ? OWNERSHIP_LABEL[x.r.drumOwnership as "mahek" | "returnable"] : "Not recorded",
            qty: x.r.quantity,
            unit: x.r.unit,
            godown: x.godown,
            testing: x.r.testingRequired ? "Yes" : "No",
            routed: x.r.routed,
            transport,
          },
          flags: [...(x.r.routed ? [] : ["awaitingRoute"]), ...(x.r.poId ? [] : ["noPo"])],
          title: x.item,
          ref: `PR ${x.r.prNumber}`,
          header: [x.r.drums ? `${x.r.drums} drums` : "", x.item, `${nf(x.r.quantity)} ${x.r.unit}`].filter(Boolean).join(" · "),
          fields: [
            { l: "Transport", v: transport },
            ...(c?.transportMode === "own_vehicle" && c.km != null && c.ratePerKmPaise
              ? [{ l: "Own vehicle", v: `${nf(c.km)} km × ${inr(c.ratePerKmPaise)}`, der: true }]
              : []),
            ...(c?.otherCostPaise ? [{ l: "Other inward cost", v: `${inr(c.otherCostPaise)}${c.otherCostNote ? ` · ${c.otherCostNote}` : ""}` }] : []),
            { l: "Remark", v: x.r.remark || "—" },
          ],
          actions,
          by: stampLine(x.by, x.r.createdAt),
        };
      })],
    };
  },
  forms: {
    async new(ctx, h, lines) {
      const config = await getConfig();
      /* NO PURCHASE WITHOUT A PO: the receipt names an approved PO, and every line one of its items. */
      const rx = await receivable();
      /*
       * A receipt started from the item names its PO on each line, and may
       * carry several POs of ONE vendor (one truck, one delivery). The PO form
       * and "Add more" name it once in the header; a line naming none takes it.
       */
      const headerPo = text(h.poFixed) ?? text(h.po);
      const gone = "No PO by that number is waiting for goods — check the number; it may be received in full or closed";
      const lineFirst = !text(h.poFixed) && lines.some((l) => text(l.po));
      if (!lineFirst && !headerPo) return fieldErr("po", "Pick the purchase order these goods came against");
      if (headerPo && !rx.find(headerPo)) return fieldErr("po", gone);
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Godown is required");
      if (!lines.length) return err("Add at least one item.");
      const all = await db.select().from(erpRawMaterials);
      const taking = new Map<string, number>();
      const corrSoFar = new Map<string, number>();
      const parsed: {
        l: Record<string, string>;
        m: (typeof all)[number];
        qty: number;
        line: PoView["lines"][number];
        po: PoView;
        correction: { kind: "extra" | "short"; quantity: number } | null;
      }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const poText = (lineFirst ? text(l.po) : null) ?? headerPo;
        const po = poText ? rx.find(poText) : undefined;
        if (!po) return fieldErr(`l${i}.poLine`, poText ? gone : "Pick the purchase order this item came against");
        if (parsed.length && po.po.supplierId !== parsed[0].po.po.supplierId)
          return fieldErr(`l${i}.poLine`, `One receipt is one supplier's delivery: ${po.supplier} is not ${parsed[0].po.supplier}. Receive it on its own GRN.`);
        const line = po.lines.find((x) => x.label === l.poLine);
        if (!line) return fieldErr(`l${i}.poLine`, "Pick an item on this PO");
        const m = all.find((x) => x.id === line.rawMaterialId)!;
        if (m.materialType === "Chemical" && (int(l.drums) == null || int(l.drums)! < 0)) return fieldErr(`l${i}.drums`, "Drums is required");
        const scale = m.materialType === "Chemical" && m.unit === "Kg";
        let qty: number | null;
        if (scale) {
          /* Net off the scale, whatever was typed into a quantity box. */
          if (!(num(l.weight)! > 0)) return fieldErr(`l${i}.weight`, "Weight with drum is required for an item bought in kg");
          const empty = num(l.emptyDrum);
          if (empty == null || empty < 0) return fieldErr(`l${i}.emptyDrum`, empty != null ? "Empty drum weight cannot be below 0." : "Empty drum weight is required");
          qty = netWeight(num(l.weight), int(l.drums), empty);
          if (qty == null) return fieldErr(`l${i}.weight`, "The empty drums weigh as much as the load — check the scale");
        } else {
          qty = num(l.qty);
          if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, qty != null && qty < 0 ? "Quantity cannot be below 0." : "Quantity received is required");
        }
        /*
         * NEVER REFUSED FOR ITS QUANTITY (0357). Whatever arrived is received;
         * a difference from what the line still expects corrects the PO with a
         * line under it — the extra unless the gate said to leave the PO, the
         * shortfall only where the gate said nothing more is coming.
         */
        const already = taking.get(line.id) ?? 0;
        const movedSoFar = corrSoFar.get(line.id) ?? 0;
        const gap = receiptGap(line.expected + movedSoFar, line.received + already, qty);
        const correction = correctionFor(gap, {
          addExtra: text(l.extra) !== EXTRA_OPTS[1],
          nothingMoreComing: text(l.short) === SHORT_OPTS[1],
        });
        /* What this line took, and how it moved the PO line, count towards the next line on the same PO line. */
        taking.set(line.id, already + qty);
        corrSoFar.set(line.id, movedSoFar + (correction?.quantity ?? 0));
        parsed.push({ l, m, qty, line, po, correction });
      }
      /* "Add more" on a PR keeps its number; a new inward draws the next one. */
      const fixed = int(h.prFixed);
      /* One PR is one supplier's delivery: more items on it come from the same supplier. */
      if (fixed != null) {
        const [onPr] = await db.select({ supplierId: erpInward.supplierId }).from(erpInward).where(eq(erpInward.prNumber, fixed)).limit(1);
        if (onPr && onPr.supplierId !== parsed[0].po.po.supplierId) return err(`PR ${fixed} is another supplier's delivery — receive ${parsed[0].po.supplier}'s goods on their own GRN.`, "rule_violation");
      }
      /* A new PR records how it came in; "Add more" leaves the PR's costs alone. */
      const costRow = fixed == null ? readPrCosts(h, config["erp.purchase.ownVehicleRatePerKmPaise"]) : null;
      if (costRow && !costRow.ok) return costRow;
      let pr = 0;
      /*
       * EACH LINE GOES WHERE IT IS GOING, IN THE SAME SAVE. Mahek Plus asked a
       * person to press "Send to Testing" or "Send to Purchase" on every line,
       * and the item's own testing list already answered which: a line that
       * needs testing is on the tester's queue, and one that does not is a
       * register row at the PO line's rate. A line the register refuses (a lot
       * number already used) stays unrouted with its manual button, rather than
       * failing the whole delivery.
       */
      const sent = { testing: 0, register: 0, stuck: [] as string[] };
      const corrected: string[] = [];
      const po = parsed[0].po;
      const poIds = [...new Set(parsed.map((x) => x.po.po.id))];
      const poNames = [...new Set(parsed.map((x) => poName(x.po.po)))];
      const [sup] = await db.select({ own: erpSuppliers.drumOwnership, partyCode: erpSuppliers.partyCode }).from(erpSuppliers).where(eq(erpSuppliers.id, po.po.supplierId));
      const supplierDrumOwnership = sup?.own ?? null;
      /* What each line became, for the receipt's What's next. */
      const saved: SavedGrnLine[] = [];
      await db.transaction(async (tx) => {
        if (fixed != null) pr = fixed;
        else {
          pr = await nextNumber(tx, "pr");
          if (costRow?.ok)
            await tx
              .insert(erpPrCosts)
              .values({ prNumber: pr, ...costRow.data, createdById: ctx.user.id, updatedById: ctx.user.id })
              .onConflictDoUpdate({ target: erpPrCosts.prNumber, set: { ...costRow.data, updatedAt: new Date(), updatedById: ctx.user.id } });
        }
        for (const { l, m, qty, line, po, correction } of parsed) {
          const inwardId = erpId("pin");
          const testing = m.testingList.length > 0;
          const receivedDate = text(h.date) ?? today();
          const unit = m.materialType === "Box" ? "Pcs" : m.unit;
          await tx.insert(erpInward).values({
            id: inwardId,
            prNumber: pr,
            receivedDate,
            supplierId: po.po.supplierId,
            godownId,
            materialType: m.materialType,
            rawMaterialId: m.id,
            drums: m.materialType === "Chemical" ? int(l.drums) : null,
            weightWithDrum: m.materialType === "Chemical" ? num(l.weight) : null,
            emptyDrumWeight: m.materialType === "Chemical" ? num(l.emptyDrum) : null,
            /* Copied from the supplier at save unless the line says otherwise; unknown stays unknown. */
            drumOwnership: m.materialType === "Chemical" ? (ownershipByLabel(l.drumOwner) ?? supplierDrumOwnership) : null,
            quantity: qty,
            unit,
            remark: text(l.remark),
            testingRequired: testing,
            poId: po.po.id,
            poLineId: line.id,
            ...(testing ? { routed: "Testing", routedAt: new Date(), routedById: ctx.user.id } : {}),
            createdById: ctx.user.id,
            updatedById: ctx.user.id,
          });
          if (correction) {
            /* Under the line it corrects, at that line's own rate and GST; the line itself is never edited. */
            await tx.insert(erpPoCorrections).values({
              id: erpId("poc"),
              poId: po.po.id,
              poLineId: line.id,
              kind: correction.kind,
              quantity: correction.quantity,
              ratePaise: line.ratePaise,
              gstBp: line.gstBp,
              inwardId,
              prNumber: pr,
              createdById: ctx.user.id,
            });
            await tx
              .update(erpPurchaseOrders)
              .set({ revision: sql`${erpPurchaseOrders.revision} + 1`, updatedAt: new Date(), updatedById: ctx.user.id })
              .where(eq(erpPurchaseOrders.id, po.po.id));
            corrected.push(`${poName(po.po)} ${correction.quantity > 0 ? "+" : "−"}${nf(Math.abs(correction.quantity))} ${line.unit} ${m.name}`);
          }
          const line0 = { item: m.name, type: m.materialType, quantity: qty, unit: unit === "Unit" ? "Pcs" : unit, drums: m.materialType === "Chemical" ? int(l.drums) : null, lot: lotNumber(sup?.partyCode ?? "", m.code, pr), po: poName(po.po) };
          if (testing) {
            sent.testing++;
            saved.push({ ...line0, routed: "Testing", purchaseId: null });
            continue;
          }
          const made = await createPurchase(tx, ctx, {
            prNumber: pr,
            purchaseDate: receivedDate,
            supplierId: po.po.supplierId,
            rawMaterialId: m.id,
            quantity: qty,
            unit: unit === "Unit" ? "Pcs" : unit,
            godownId,
            drums: m.materialType === "Chemical" ? int(l.drums) : null,
            weightWithDrum: m.materialType === "Chemical" ? num(l.weight) : null,
            remark: text(l.remark),
            source: "inward",
            inwardId,
            ...poTerms(po.po.poNumber, po.po.id, line),
          });
          if (made.ok) {
            await tx.update(erpInward).set({ routed: "Purchase", routedAt: new Date(), routedById: ctx.user.id }).where(eq(erpInward.id, inwardId));
            sent.register++;
            saved.push({ ...line0, lot: made.data.lotNo, routed: "Purchase", purchaseId: made.data.id });
          } else {
            sent.stuck.push(m.name);
            saved.push({ ...line0, routed: null, purchaseId: null });
          }
        }
        for (const id of poIds) await refreshPurchaseOrder(tx, id);
      });
      await erpAudit(ctx, "erp.inward.create", "erp_inward", String(pr), null, { lines: parsed.length, po: poNames.join(", "), supplier: po.supplier, ...sent, corrected });
      const where = [sent.testing ? `${sent.testing} to testing` : "", sent.register ? `${sent.register} in the register` : ""].filter(Boolean).join(", ");
      const godownName = (await db.select({ name: erpGodowns.name }).from(erpGodowns).where(eq(erpGodowns.id, godownId)))[0]?.name ?? "";
      return ok(
        {
          /* WHAT'S NEXT (the GRN's step 5): every line's labels, testing and bill, from what this save did. */
          next: {
            pr,
            supplier: po.supplier,
            godown: godownName,
            pos: poNames,
            lines: whatsNext(saved, {
              /* The label print answers to these screens (`app/erp/print-labels`). */
              canLabels: ["barcode", "register", "stock", "inward"].some((k) => ctx.screens.has(k)),
              /* Recording the bill is Bills' act: the page, its Edit tick and purchase money. */
              canBill: ctx.screens.has("register") && holdsTick(ctx, "register", "edit") && ctx.powers.has("viewPurchaseMoney"),
              testedBy: testingTeamFor,
              labelsHref: (id) => erpLabelsHref({ purchase: id }),
              billHref: (id) => erpLink("register", { open: id }),
              nf,
            }),
          } satisfies GrnNext,
        },
        `PR ${pr} · ${parsed.length} line${parsed.length > 1 ? "s" : ""} received against ${poNames.join(", ")}${where ? ` · ${where}` : ""}` +
          (corrected.length ? ` · PO corrected: ${corrected.join("; ")}` : "") +
          (sent.stuck.length ? ` · ${sent.stuck.join(", ")} not in the register: that lot number is taken — change the PR number and send it` : ""),
      );
    },
    async edit(ctx, h, _lines, id) {
      if (!id) return err("No line named.", "not_found");
      const [was] = await db.select().from(erpInward).where(eq(erpInward.id, id));
      if (!was) return err("That line no longer exists.", "not_found");
      /* A different PO line moves the receipt first; the figures below are then read for the item it is now. */
      let target: { poLineId: string } | null = null;
      /* Blank keeps the PO line it is on (and is what an older page sends). */
      if (text(h.po)) {
        const rx = await receivable(false, was.poId ? [was.poId] : []);
        const po = rx.find(text(h.po));
        if (!po) return fieldErr("po", "Pick the purchase order these goods came on");
        const line = po.lines.find((l) => l.label === text(h.poLine));
        if (!line) return fieldErr("poLine", "Pick an item on this PO");
        if (line.id !== was.poLineId) target = { poLineId: line.id };
      }
      const [lineMat] = target
        ? await db.select({ m: erpRawMaterials }).from(erpPoLines).innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpPoLines.rawMaterialId)).where(eq(erpPoLines.id, target.poLineId))
        : [];
      const r: InwardRow = lineMat ? { ...was, rawMaterialId: lineMat.m.id, materialType: lineMat.m.materialType } : was;
      const [m] = await db.select({ unit: erpRawMaterials.unit }).from(erpRawMaterials).where(eq(erpRawMaterials.id, r.rawMaterialId));
      const godownId = await godownIdByName(text(h.godown));
      if (!godownId) return fieldErr("godown", "Godown is required");
      const receivedDate = text(h.date);
      if (!receivedDate) return fieldErr("date", "Date received is required");
      const chemical = r.materialType === "Chemical";
      const scale = chemical && m?.unit === "Kg";
      const drums = chemical ? int(h.drums) : null;
      if (chemical && (drums == null || drums < 0)) return fieldErr("drums", "Drums is required");
      const weight = chemical ? num(h.weight) : null;
      const empty = chemical ? num(h.emptyDrum) : null;
      let quantity: number | null;
      if (scale) {
        if (!(weight! > 0)) return fieldErr("weight", "Weight with drum is required for an item bought in kg");
        if (empty == null || empty < 0) return fieldErr("emptyDrum", empty != null ? "Empty drum weight cannot be below 0." : "Empty drum weight is required");
        quantity = netWeight(weight, drums, empty);
        if (quantity == null) return fieldErr("weight", "The empty drums weigh as much as the load — check the scale");
      } else {
        quantity = num(h.qty);
        if (quantity == null || quantity <= 0) return fieldErr("qty", quantity != null && quantity < 0 ? "Quantity cannot be below 0." : "Quantity received is required");
      }
      /* A corrected quantity is never refused for being more or less than the PO (0357); the PO's status follows it. */
      const next: InwardChange = {
        receivedDate,
        godownId,
        drums,
        weightWithDrum: weight,
        emptyDrumWeight: empty,
        quantity,
        drumOwnership: chemical ? await drumOwnerNamed(h.drumOwner, r.supplierId) : null,
        remark: text(h.remark),
      };
      const res = await inTx(async (tx) => {
        const touched = target ? await retargetReceipt(tx, ctx, { inwardId: id }, target) : [];
        /* Read back after the move, so the change below is measured against what the line now says. */
        const [now] = await tx.select().from(erpInward).where(eq(erpInward.id, id));
        if (target && now.materialType === "Chemical" && next.drumOwnership == null) next.drumOwnership = await drumOwnerNamed(h.drumOwner, now.supplierId, tx);
        await writeInwardChange(tx, ctx, now, next);
        for (const poId of touched) await refreshPurchaseOrder(tx, poId);
        return okVoid(`PR ${was.prNumber} line saved${target ? " · moved to the PO item picked" : ""}`);
      });
      if (res.ok) await erpAudit(ctx, "erp.inward.edit", "erp_inward", id, was, { ...next, ...(target ? { moved: target } : {}) });
      return res;
    },
    /* A PR's transport and other cost, recorded or corrected after the inward. */
    async costs(ctx, h, _lines, recordId) {
      const pr = int(recordId);
      if (pr == null) return err("Which PR is this?", "not_found");
      const [line] = await db.select({ id: erpInward.id }).from(erpInward).where(eq(erpInward.prNumber, pr)).limit(1);
      if (!line) return err(`PR ${pr} is not in goods inward.`, "not_found");
      const [before] = await db.select().from(erpPrCosts).where(eq(erpPrCosts.prNumber, pr));
      const row = readPrCosts(h, (await getConfig())["erp.purchase.ownVehicleRatePerKmPaise"], before);
      if (!row.ok) return row;
      await db
        .insert(erpPrCosts)
        .values({ prNumber: pr, ...row.data, createdById: ctx.user.id, updatedById: ctx.user.id })
        .onConflictDoUpdate({ target: erpPrCosts.prNumber, set: { ...row.data, updatedAt: new Date(), updatedById: ctx.user.id } });
      await erpAudit(ctx, "erp.inward.costs", "erp_pr_costs", String(pr), before ?? null, row.data);
      return okVoid(`PR ${pr} · transport and costs saved`);
    },
  },
  formLoaders: {
    edit: (ctx, id) => inwardEditForm(ctx, id),
    /* Goods in's Expected at the gate: the GRN on one PO line, or on every open line of its supplier at its godown. */
    receive: (ctx, id) => gateReceiptForm(ctx, id, false),
    receiveAll: (ctx, id) => gateReceiptForm(ctx, id, true),
  },
  bulk: {
    /* The row act on each ticked line in turn: each line is its own decision,
       so one already sent does not hold back the rest, and the count says so. */
    async toTesting(ctx, ids) {
      return eachLine(ids, (id) => inward.actions!.toTesting(ctx, id, {}), "sent to Testing", "already sent, or not needing testing");
    },
    async toPurchase(ctx, ids) {
      return eachLine(ids, (id) => inward.actions!.toPurchase(ctx, id, {}), "sent to Purchase", "already sent, or needing testing first");
    },
    async editMany(ctx, ids, values) {
      const date = text(values.date);
      const godownName = text(values.godown);
      const owner = text(values.drumOwner);
      const remark = text(values.remark);
      if (!date && !godownName && !owner && !remark) return err("Fill in at least one box. Blank keeps what each line has.", "rule_violation");
      const godownId = godownName ? await godownIdByName(godownName) : null;
      if (godownName && !godownId) return fieldErr("godown", "Pick a godown from the list");
      const rows = await db.select().from(erpInward).where(inArray(erpInward.id, ids));
      if (!rows.length) return err("Those lines no longer exist.", "not_found");
      /* All of them or none: half a selection changed is harder to put right than a failure. */
      await db.transaction(async (tx) => {
        for (const r of rows) {
          await writeInwardChange(tx, ctx, r, {
            receivedDate: date ?? r.receivedDate,
            godownId: godownId ?? r.godownId,
            drums: r.drums,
            weightWithDrum: r.weightWithDrum,
            emptyDrumWeight: r.emptyDrumWeight,
            quantity: r.quantity,
            drumOwnership: owner && r.materialType === "Chemical" ? await drumOwnerNamed(owner, r.supplierId, tx) : r.drumOwnership,
            remark: remark ?? r.remark,
          });
        }
      });
      await erpAudit(ctx, "erp.inward.edit", "erp_inward", rows.map((r) => r.id).join(","), null, { date, godown: godownName, drumOwner: owner, remark });
      const skipped = owner ? rows.filter((r) => r.materialType !== "Chemical").length : 0;
      return okVoid(`${rows.length} line${rows.length > 1 ? "s" : ""} saved${skipped ? ` · drum owner not set on ${skipped} that carry no drums` : ""}`);
    },
  },
  actions: {
    async void(ctx, id, values) {
      if (!mayVoidInward(ctx)) return err(VOID_WHY, "not_permitted");
      return voidInward(ctx, id, values);
    },
    /* Routing a line is claimed in the same statement that checks it has not
       been routed, so two people pressing at once route it once. */
    async toTesting(ctx, id) {
      const res = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(erpInward)
          .set({ routed: "Testing", routedAt: new Date(), routedById: ctx.user.id })
          .where(and(eq(erpInward.id, id), isNull(erpInward.routed), eq(erpInward.testingRequired, true)))
          .returning();
        if (!claimed.length) return err("This line has already been sent, or does not need testing.", "conflict");
        return okVoid(`PR ${claimed[0].prNumber} sent to testing`);
      });
      if (res.ok) await erpAudit(ctx, "erp.inward.toTesting", "erp_inward", id);
      return res;
    },
    async toPurchase(ctx, id) {
      const res = await db.transaction(async (tx): Promise<Result<unknown>> => {
        const claimed = await tx
          .update(erpInward)
          .set({ routed: "Purchase", routedAt: new Date(), routedById: ctx.user.id })
          .where(and(eq(erpInward.id, id), isNull(erpInward.routed), eq(erpInward.testingRequired, false)))
          .returning();
        if (!claimed.length) return err("This line has already been sent, or needs testing first.", "conflict");
        const r = claimed[0];
        const made = await createPurchase(tx, ctx, {
          prNumber: r.prNumber,
          purchaseDate: r.receivedDate,
          supplierId: r.supplierId,
          rawMaterialId: r.rawMaterialId,
          quantity: r.quantity,
          unit: r.unit === "Unit" ? "Pcs" : r.unit,
          godownId: r.godownId,
          drums: r.drums,
          remark: r.remark,
          source: "inward",
          inwardId: r.id,
          ...(await poTermsOfInward(tx, r)),
        });
        if (!made.ok) {
          tx.rollback();
          return made;
        }
        return okVoid("Sent to the purchase register · it posts to stock once a rate is entered");
      }).catch((e: unknown) => (e instanceof Error && e.message === "Rollback" ? null : Promise.reject(e)));
      if (!res) return err("That PR number is already taken. Change it, or generate a new one.", "conflict");
      if (res.ok) await erpAudit(ctx, "erp.inward.toPurchase", "erp_inward", id);
      return res;
    },
  },
};

/* ============================================================== testing */

/* One list of evidence for both kinds of test (`engines/sfg-tests.ts`); a
   purchase test needs every piece its item's tests name, bar the pH reading. */
const TEST_FIELDS: { test: string; field: FieldSpec }[] = EVIDENCE_FIELDS.map(({ test, ...field }) => ({
  test,
  field: { ...field, req: field.k !== "phValue" },
}));

const PHOTO_COL: Record<string, keyof typeof erpTests.$inferInsert> = {
  ph: "phPhotoId",
  color: "colorPhotoId",
  oil: "oilPhotoId",
  fast: "fastPhotoId",
  nc: "ncPhotoId",
  primer: "primerPhotoId",
  densityPhoto: "densityPhotoId",
  thermocol: "thermocolPhotoId",
  video: "videoId",
};

/**
 * The Tester picker offers PEOPLE: each option is an account id, labelled with
 * the name it carries today, so the form sends who and never a name. The
 * record's own tester stays on the list even if their account was switched
 * off since, so an edit never blanks them.
 */
async function testerPick(keep: string | null): Promise<{ opts: string[]; optLabels: Record<string, string> }> {
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(keep ? or(eq(users.active, true), eq(users.id, keep)) : eq(users.active, true))
    .orderBy(asc(users.name));
  return { opts: rows.map((u) => u.id), optLabels: Object.fromEntries(rows.map((u) => [u.id, u.name])) };
}

async function testForm(ctx: ErpContext, testId?: string): Promise<FormSpec | null> {
  const gds = await godownOptions(ctx, { lost: false });
  const evidence = (on: string) =>
    TEST_FIELDS.map(({ test, field }) => ({ ...field, when: { k: on, map: "testsOf", has: test } }) as FieldSpec);

  if (testId) {
    const [t] = await db
      .select({ t: erpTests, item: erpRawMaterials.name })
      .from(erpTests)
      .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpTests.rawMaterialId))
      .where(eq(erpTests.id, testId));
    if (!t) return null;
    const line = `PR ${t.t.prNumber} · ${t.item}`;
    return {
      screen: "testing",
      id: "edit",
      recordId: testId,
      title: "Record test evidence",
      sub: `${line} · only the evidence this item's tests need is asked for.`,
      submit: "Save test",
      data: { testsOf: { [line]: t.t.tests } },
      init: {
        line,
        smell: t.t.smell ?? "",
        density: t.t.density == null ? "" : String(t.t.density),
        phValue: t.t.phValue == null ? "" : String(t.t.phValue),
        ph: t.t.phPhotoId ?? "",
        color: t.t.colorPhotoId ?? "",
        oil: t.t.oilPhotoId ?? "",
        fast: t.t.fastPhotoId ?? "",
        nc: t.t.ncPhotoId ?? "",
        primer: t.t.primerPhotoId ?? "",
        densityPhoto: t.t.densityPhotoId ?? "",
        thermocol: t.t.thermocolPhotoId ?? "",
        video: t.t.videoId ?? "",
        tester: t.t.testerId ?? ctx.user.id,
        date: t.t.testingDate,
        remark: t.t.remark ?? "",
      },
      header: [
        { k: "line", l: "Inward line", t: "text", readOnly: true },
        { k: "tests", l: "Tests required", t: "derived", calc: "testing.tests" },
        ...evidence("line"),
        { k: "video", l: "Test video", t: "video" },
        { k: "tester", l: "Tester", t: "select", req: true, ...(await testerPick(t.t.testerId)) },
        { k: "date", l: "Testing date", t: "date", req: true },
        { k: "remark", l: "Remark", t: "area", mic: true },
      ],
    };
  }

  /* A new test is for an inward line sent to testing and not yet tested. */
  const lines = await db
    .select({ id: erpInward.id, pr: erpInward.prNumber, item: erpRawMaterials.name, itemId: erpRawMaterials.id, tests: erpRawMaterials.testingList })
    .from(erpInward)
    .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpInward.rawMaterialId))
    .where(and(eq(erpInward.routed, "Testing"), sql`not exists (select 1 from erp_tests t where t.inward_id = ${erpInward.id})`))
    .orderBy(desc(erpInward.prNumber));
  const testsOf: Record<string, string[]> = {};
  const lineId: Record<string, string> = {};
  lines.forEach((l) => {
    const label = `PR ${l.pr} · ${l.item}`;
    testsOf[label] = l.tests;
    lineId[label] = l.id;
  });
  return {
    screen: "testing",
    id: "new",
    title: "Record a purchase test",
    sub: "Only the evidence the item's tests need is asked for.",
    submit: "Save test",
    data: { testsOf, lineId },
    init: { tester: ctx.user.id, date: today(), godown: ctx.workingGodown?.name ?? "" },
    header: [
      { k: "line", l: "Inward line", t: "select", req: true, sec: "Lot", opts: Object.keys(testsOf), hint: lines.length ? undefined : "No inward line is waiting for a test. Lines needing a test arrive here as they are received on Purchases → Goods receipt (GRN)." },
      { k: "tests", l: "Tests required", t: "derived", calc: "testing.tests" },
      ...evidence("line").map((f, i) => (i === 0 ? { ...f, sec: "Readings" } : f)),
      { k: "video", l: "Test video", t: "video", when: { k: "line", notEmpty: true } },
      { k: "tester", l: "Tester", t: "select", req: true, sec: "Recorded by", ...(await testerPick(ctx.user.id)) },
      { k: "date", l: "Testing date", t: "date", req: true },
      godownField(gds),
      { k: "remark", l: "Remark", t: "area", mic: true },
    ],
  };
}

/** Evidence a test still lacks for the tests its item needs. */
function missingEvidence(t: typeof erpTests.$inferSelect): string[] {
  const miss: string[] = [];
  for (const test of t.tests) {
    if (test === "PH" && !t.phPhotoId) miss.push("pH photo");
    if (test === "Smell" && !t.smell) miss.push("smell");
    if (test === "Color" && !t.colorPhotoId) miss.push("colour photo");
    if (test === "Oil Paint" && !t.oilPhotoId) miss.push("oil-paint photo");
    if (test === "Fast Paints" && !t.fastPhotoId) miss.push("fast-paint photo");
    if (test === "Nc Paints" && !t.ncPhotoId) miss.push("NC-paint photo");
    if (test === "Primer" && !t.primerPhotoId) miss.push("primer photo");
    if (test === "Density" && (t.density == null || !t.densityPhotoId)) miss.push("density and its photo");
    if (test === "Tharmakol Pass" && !t.thermocolPhotoId) miss.push("thermocol-pass photo");
  }
  return miss;
}

/**
 * LOT TESTING IS A QUEUE (Nov 2026): To test · To verify · Verified · Failed
 * (`engines/lot-testing.ts`). A line routed to testing at the gate is To test
 * BEFORE any test row exists — its row is the inward line, and Record test
 * opens the test form on it. To test and To verify are read whole, oldest
 * first: a lot waiting is work whatever the period. Only Verified and Failed
 * follow the period picker, by testing date.
 */
const TEST_WINDOW = { label: "Testing date", default: REGISTER_DEFAULT } as const;

const testing: ScreenModule = {
  key: "testing",
  window: TEST_WINDOW,
  async load(ctx, s) {
    const sc = s ?? unscoped();
    /* Decided tests follow the window; an undecided one is waiting, and always read. */
    const decided = windowWhere(sql`${erpTests.testingDate}`, sql`${erpTests.id}`, sc);
    const where = sc.ids?.length ? decided : sql`(${decided} or ${erpTests.decidedAt} is null)`;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(erpTests).where(sql`${decided} and ${erpTests.decidedAt} is not null`);
    const wide = tooWide(Number(n), sc);
    const [rows, untested, config] = await Promise.all([
      db
        .select({
          t: erpTests,
          item: erpRawMaterials.name,
          itemCode: erpRawMaterials.code,
          godown: erpGodowns.name,
          tester: users.name,
          supplier: erpSuppliers.name,
          partyCode: erpSuppliers.partyCode,
          receivedAt: erpInward.createdAt,
          poNumber: erpPurchaseOrders.poNumber,
          qmPoNo: erpPurchaseOrders.qmPoNo,
        })
        .from(erpTests)
        .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpTests.rawMaterialId))
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpTests.godownId))
        .leftJoin(users, eq(users.id, erpTests.testerId))
        .leftJoin(erpSuppliers, eq(erpSuppliers.id, erpTests.supplierId))
        .leftJoin(erpInward, eq(erpInward.id, erpTests.inwardId))
        .leftJoin(erpPurchaseOrders, eq(erpPurchaseOrders.id, erpInward.poId))
        .where(wide ? sql`${erpTests.decidedAt} is null` : where)
        .orderBy(desc(erpTests.testingDate), desc(erpTests.prNumber)),
      /* TO TEST: routed to testing, nothing recorded yet. */
      db
        .select({
          inw: erpInward,
          item: erpRawMaterials.name,
          itemCode: erpRawMaterials.code,
          tests: erpRawMaterials.testingList,
          godown: erpGodowns.name,
          supplier: erpSuppliers.name,
          partyCode: erpSuppliers.partyCode,
          poNumber: erpPurchaseOrders.poNumber,
          qmPoNo: erpPurchaseOrders.qmPoNo,
        })
        .from(erpInward)
        .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpInward.rawMaterialId))
        .innerJoin(erpGodowns, eq(erpGodowns.id, erpInward.godownId))
        .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpInward.supplierId))
        .leftJoin(erpPurchaseOrders, eq(erpPurchaseOrders.id, erpInward.poId))
        .where(
          and(
            eq(erpInward.routed, "Testing"),
            sql`not exists (select 1 from erp_tests t where t.inward_id = ${erpInward.id})`,
            sc.ids?.length ? inArray(erpInward.id, sc.ids) : undefined,
          ),
        ),
      getConfig(),
    ]);
    const waitHours = config["erp.purchase.testWaitingHours"];
    const now = Date.now();
    const testIds = rows.map((x) => x.t.id);
    const withRegister = new Set(
      (testIds.length ? await db.select({ testId: erpPurchases.testId }).from(erpPurchases).where(inArray(erpPurchases.testId, testIds)) : []).map((x) => x.testId!),
    );
    const newForm = await testForm(ctx);
    const verifier = ctx.powers.has("verifyTest");
    const ai = await import("../ai");
    const pendingPhotos = await ai.pendingFor("photos");
    const photosOn = (await ai.featureState("photos", true)).on;
    const why = verifier ? "" : "Only the verifier decides a purchase test";
    const cols: ColSpec[] = [
      { k: "lot", l: "Lot", t: "mono" },
      { k: "item", l: "Item", t: "b", sub: "line" },
      { k: "received", l: "Received", t: "at" },
      { k: "waiting", l: "Waiting", t: "t", alert: "late" },
      { k: "tests", l: "Tests required", t: "t", tags: true },
      { k: "godown", l: "Godown", t: "t" },
      { k: "stock", l: "Stock", t: "s" },
      { k: "tester", l: "Tested by", t: "t" },
      { k: "smell", l: "Smell", t: "s" },
      { k: "density", l: "Density", t: "n" },
      { k: "date", l: "Testing date", t: "d" },
      { k: "pr", l: "PR no", t: "mono" },
      { k: "supplier", l: "Supplier", t: "t" },
    ];
    /* "PR-15 · PO-2 · Asian Solvents": where the lot came from, under its item. */
    const lineOf = (pr: number, po: { poNumber: number | null; qmPoNo: string | null }, supplier: string | null) =>
      [`PR-${pr}`, po.poNumber != null ? poName({ poNumber: po.poNumber, qmPoNo: po.qmPoNo }) : null, supplier].filter(Boolean).join(" · ");
    const waited = (at: Date | string | null) => {
      if (!at) return { waiting: null, late: null };
      const ms = now - new Date(at).getTime();
      return { waiting: waitingText(ms), late: waitedTooLong(ms, waitHours) ? "late" : null };
    };
    const QUEUE = "Every lot waiting, oldest first";
    const toTestRows: ListRow[] = untested.map((x) => {
      const i = x.inw;
      const line = lineOf(i.prNumber, x, x.supplier);
      return {
        id: i.id,
        v: {
          bucket: "toTest",
          lot: lotNumber(x.partyCode, x.itemCode, i.prNumber),
          item: x.item,
          line,
          received: i.createdAt.toISOString(),
          ...waited(i.createdAt),
          tests: x.tests.join(", ") || null,
          godown: x.godown,
          stock: STOCK_WORDS.toTest,
          tester: null,
          smell: null,
          density: null,
          date: null,
          pr: String(i.prNumber),
          supplier: x.supplier,
        },
        flags: [],
        title: x.item,
        ref: `PR-${i.prNumber}`,
        header: `${line} · ${nf(i.quantity)} ${i.unit} · nothing recorded yet`,
        fields: [{ l: "Remark", v: i.remark || "—" }],
        /* Recording a test is Access: the department tests what it receives. */
        actions: [{ id: "record", l: "Record test", primary: true, loadsForm: true }],
      };
    });
    return {
      spec: {
        screen: "testing",
        cols,
        hidden: [],
        subtabs: [
          { id: "toTest", l: "To test", k: "bucket", in: ["toTest"], allTime: true, note: QUEUE, sort: ["received", 1], hide: ["tester", "smell", "density", "date"], hint: "Arrived and routed to testing; no test recorded yet" },
          { id: "toVerify", l: "To verify", k: "bucket", in: ["toVerify"], allTime: true, note: QUEUE, sort: ["received", 1], hide: ["stock", "date"], hint: "Recorded, waiting for the verifier" },
          { id: "verified", l: "Verified", k: "bucket", in: ["verified"], hide: ["waiting"] },
          { id: "failed", l: "Failed", k: "bucket", in: ["failed"], hide: ["waiting"], hint: "Marked not verified by the verifier" },
        ],
        sortDefault: ["received", -1],
        godownKey: "godown",
        /* The sub-tabs carry the counts; the design draws no figure cards here. */
        stats: [],
        filters: ["item", "supplier", "tester", "godown"],
        newForm: newForm ?? undefined,
        newLabel: "New test",
        noDataLine: "No lots to test. Chemical lots arrive here as they are received.",
      },
      tooWide: wide,
      rows: [
        ...toTestRows,
        ...rows.map((x): ListRow => {
          const reg = withRegister.has(x.t.id);
          const miss = missingEvidence(x.t);
          const bucket = testBucket(x.t);
          /* Stored "Not Verified" is also the default before anybody decides;
             an undecided test reads as waiting, never as rejected. */
          const shown = x.t.decidedAt ? x.t.status : "Pending";
          const open = x.t.status !== "Verified";
          const actions: ActionSpec[] = [];
          /* The next step: evidence still missing is recorded first, then the verifier decides. */
          if (open) actions.push({ id: "edit", l: "Record evidence", loadsForm: true, ...(bucket === "toVerify" && miss.length ? { primary: true } : {}) });
          if (open && pendingPhotos.has(x.t.id)) {
            actions.push({ id: "aiTest", l: "Review photo readings", ai: true, loadsForm: true });
            actions.push({ id: "aiTestReject", l: "Reject photo readings", confirm: "Reject the AI readings? Nothing changes." });
          } else if (open && photosOn && (x.t.densityPhotoId || x.t.phPhotoId)) actions.push({ id: "aiTestRead", l: "Read test photos", ai: true });
          actions.push({ id: "addLot", l: "Add another test", loadsForm: true });
          if (open)
            actions.push({
              id: "verify",
              l: "Verify",
              primary: bucket === "toVerify" && !miss.length,
              why: why || (miss.length ? `Evidence missing: ${miss.join(", ")}` : ""),
            });
          if (shown !== "Not Verified" || reg)
            actions.push({
              id: "unverify",
              l: "Not verified",
              why,
              confirm: reg
                ? `A purchase register row already exists for this lot. Marking it Not Verified leaves that row in place — remove it from the register separately.`
                : `Mark ${x.item} (PR ${x.t.prNumber}) Not Verified?`,
            });
          const line = lineOf(x.t.prNumber, x, x.supplier);
          const from = x.receivedAt ?? x.t.createdAt;
          return {
            id: x.t.id,
            v: {
              bucket,
              lot: lotNumber(x.partyCode, x.itemCode, x.t.prNumber),
              item: x.item,
              line,
              received: new Date(from).toISOString(),
              /* Only a lot still waiting has a waiting time; a decided one is a record. */
              ...(bucket === "toVerify" ? waited(from) : { waiting: null, late: null }),
              tests: x.t.tests.join(", ") || null,
              godown: x.godown,
              stock: STOCK_WORDS[bucket],
              tester: x.tester,
              smell: x.t.smell,
              density: x.t.density,
              date: x.t.testingDate,
              pr: String(x.t.prNumber),
              supplier: x.supplier,
              status: shown,
            },
            flags: [],
            title: x.item,
            ref: `PR-${x.t.prNumber}`,
            header: `${line}${x.t.quantity ? ` · ${nf(x.t.quantity)} ${x.t.unit ?? ""}` : ""}`,
            fields: [{ l: "Remark", v: x.t.remark || "—" }],
            actions,
            panel: {
              kind: "testEvidence",
              data: {
                status: shown,
                tests: x.t.tests,
                smell: x.t.smell,
                density: x.t.density,
                phValue: x.t.phValue,
                photos: {
                  PH: x.t.phPhotoId,
                  Color: x.t.colorPhotoId,
                  "Oil Paint": x.t.oilPhotoId,
                  "Fast Paints": x.t.fastPhotoId,
                  "Nc Paints": x.t.ncPhotoId,
                  Primer: x.t.primerPhotoId,
                  Density: x.t.densityPhotoId,
                  "Tharmakol Pass": x.t.thermocolPhotoId,
                },
                video: x.t.videoId,
                registerExists: reg,
              },
            },
            by: stampLine(x.tester, x.t.createdAt),
          };
        }),
      ],
    };
  },
  formLoaders: {
    edit: (ctx, id) => testForm(ctx, id),
    /* Record test on a To test row: the new test's form, already on that inward line. */
    record: async (ctx, inwardId) => {
      const f = await testForm(ctx);
      if (!f) return null;
      const line = Object.entries((f.data?.lineId ?? {}) as Record<string, string>).find(([, v]) => v === inwardId)?.[0];
      if (!line) return null;
      const [inw] = await db.select({ godown: erpGodowns.name }).from(erpInward).innerJoin(erpGodowns, eq(erpGodowns.id, erpInward.godownId)).where(eq(erpInward.id, inwardId));
      return { ...f, init: { ...f.init, line, godown: inw?.godown ?? f.init?.godown ?? "" } };
    },
    aiTest: async (ctx, id) => {
      const base = await testForm(ctx, id);
      return base ? (await import("../ai-photos")).testReviewForm(base, id) : null;
    },
    /* ADD More Lot: a new test for the same inward line's PR and item. */
    addLot: async (ctx, id) => {
      const [t] = await db.select({ inward: erpTests.inwardId }).from(erpTests).where(eq(erpTests.id, id));
      const f = await testForm(ctx);
      if (!f || !t) return f;
      return { ...f, id: "copy", recordId: id, title: "Add another lot to this test", init: { ...f.init } };
    },
  },
  forms: {
    async new(ctx, h) {
      const f = await testForm(ctx);
      const lineId = ((f?.data?.lineId ?? {}) as Record<string, string>)[h.line ?? ""];
      if (!lineId) return fieldErr("line", "Pick an inward line waiting for a test");
      const [inw] = await db.select().from(erpInward).where(eq(erpInward.id, lineId));
      if (!inw) return fieldErr("line", "That inward line no longer exists");
      return saveTest(ctx, h, { inward: inw });
    },
    async copy(ctx, h, _l, sourceId) {
      const [src] = sourceId ? await db.select().from(erpTests).where(eq(erpTests.id, sourceId)) : [];
      if (!src) return err("The test being copied no longer exists.", "not_found");
      return saveTest(ctx, h, { copyOf: src });
    },
    async edit(ctx, h, _l, id) {
      if (!id) return err("No test named.", "not_found");
      const [t] = await db.select().from(erpTests).where(eq(erpTests.id, id));
      if (!t) return err("That test no longer exists.", "not_found");
      if (t.status === "Verified") return err("A verified test is closed. Mark it Not Verified first to change its evidence.", "rule_violation");
      return saveTest(ctx, h, { existing: t });
    },
    /* AI-8: the same save as recording evidence by hand, then the reading is logged as accepted or edited. */
    async aiTest(ctx, h, _l, suggestionId) {
      const { erpAiSuggestions } = await import("@/db/schema");
      const [s] = suggestionId ? await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, suggestionId)) : [];
      if (!s?.recordId) return err("That reading has already been decided.", "conflict");
      const [t] = await db.select().from(erpTests).where(eq(erpTests.id, s.recordId));
      if (!t) return err("That test no longer exists.", "not_found");
      if (t.status === "Verified") return err("A verified test is closed.", "rule_violation");
      const res = await saveTest(ctx, h, { existing: t });
      if (res.ok) await (await import("../ai-photos")).decideTestReading(s.id, h);
      return res;
    },
  },
  actions: {
    aiTestRead: async (ctx, id) => (await import("../ai-photos")).readTestPhotos(ctx, id),
    aiTestReject: async (ctx, id) => (await import("../ai-photos")).rejectPhotoReading(ctx, id),
    async verify(ctx, id) {
      if (!ctx.powers.has("verifyTest")) return err("Only the verifier decides a purchase test.", "not_permitted");
      const [t] = await db.select().from(erpTests).where(eq(erpTests.id, id));
      if (!t) return err("That test no longer exists.", "not_found");
      if (t.status === "Verified") return err("Already verified.", "conflict");
      const miss = missingEvidence(t);
      if (miss.length) return err(`Evidence missing: ${miss.join(", ")}`, "rule_violation");
      let lot = "";
      const res = await db
        .transaction(async (tx): Promise<Result<unknown>> => {
          await tx
            .update(erpTests)
            .set({ status: "Verified", decidedById: ctx.user.id, decidedAt: new Date(), updatedAt: new Date() })
            .where(eq(erpTests.id, id));
          /* Test To Purchase: once only (spec §5.4). */
          const [exists] = await tx.select({ id: erpPurchases.id }).from(erpPurchases).where(eq(erpPurchases.testId, id));
          if (exists) return okVoid("Verified · a register row already existed for this lot");
          const inw = t.inwardId ? (await tx.select().from(erpInward).where(eq(erpInward.id, t.inwardId)))[0] : null;
          if (!t.supplierId) {
            tx.rollback();
          }
          const made = await createPurchase(tx, ctx, {
            prNumber: t.prNumber,
            purchaseDate: t.testingDate,
            supplierId: t.supplierId!,
            rawMaterialId: t.rawMaterialId,
            quantity: t.quantity ?? inw?.quantity ?? 0,
            unit: t.unit === "Unit" ? "Pcs" : (t.unit ?? "Litre"),
            godownId: t.godownId,
            drums: t.drums,
            weightWithDrum: t.weightWithDrum,
            density: t.density,
            remark: t.remark,
            source: "test",
            testId: t.id,
            ...(await poTermsOfInward(tx, inw)),
          });
          if (!made.ok) {
            tx.rollback();
          } else lot = made.data.lotNo;
          return okVoid(`Verified · a purchase register row was created for lot ${lot}`);
        })
        .catch((e: unknown) => (e instanceof Error && e.message === "Rollback" ? null : Promise.reject(e)));
      if (!res) return err("That PR number is already taken. Change it, or generate a new one.", "conflict");
      await erpAudit(ctx, "erp.test.verify", "erp_test", id);
      return res;
    },
    async unverify(ctx, id) {
      if (!ctx.powers.has("verifyTest")) return err("Only the verifier decides a purchase test.", "not_permitted");
      await db
        .update(erpTests)
        .set({ status: "Not Verified", decidedById: ctx.user.id, decidedAt: new Date(), updatedAt: new Date() })
        .where(eq(erpTests.id, id));
      await erpAudit(ctx, "erp.test.unverify", "erp_test", id);
      return okVoid("Marked Not Verified");
    },
  },
};

async function saveTest(
  ctx: ErpContext,
  h: Record<string, string>,
  from: { inward?: typeof erpInward.$inferSelect; copyOf?: typeof erpTests.$inferSelect; existing?: typeof erpTests.$inferSelect },
) {
  const src = from.inward ?? null;
  const base = from.existing ?? from.copyOf ?? null;
  const rawMaterialId = src?.rawMaterialId ?? base!.rawMaterialId;
  const [mat] = await db.select().from(erpRawMaterials).where(eq(erpRawMaterials.id, rawMaterialId));
  if (!mat) return err("The item no longer exists.", "not_found");
  const tests = from.existing?.tests ?? mat.testingList;
  /* The Tester picker sends the person's account id; blank is whoever saves.
     A tab opened before the picker sent ids still sends the name it showed,
     and that is turned into ONE person through the directory or refused —
     never quietly recorded as whoever pressed Save. */
  const picked = text(h.tester);
  let testerId: string = ctx.user.id;
  if (picked) {
    const [byId] = await db.select({ id: users.id }).from(users).where(eq(users.id, picked)).limit(1);
    if (byId) testerId = byId.id;
    else {
      const { loadStaffResolver } = await import("@/lib/services/person-identity-service");
      const m = (await loadStaffResolver())(picked);
      if (!m.userId) return fieldErr("tester", "Pick the tester from the list.");
      testerId = m.userId;
    }
  }
  const density = num(h.density);
  if (tests.includes("Density") && density != null && (density < 0.5 || density > 1.5)) return fieldErr("density", "Density must be between 0.5 and 1.5.");
  const photoIds: Record<string, string | null> = {};
  for (const [k, col] of Object.entries(PHOTO_COL)) photoIds[col as string] = text(h[k]);
  const values = {
    smell: tests.includes("Smell") ? text(h.smell) : null,
    density: tests.includes("Density") ? density : null,
    phValue: tests.includes("PH") ? num(h.phValue) : null,
    ...photoIds,
    testerId,
    testingDate: text(h.date) ?? today(),
    remark: text(h.remark),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  const id = from.existing?.id ?? erpId("tst");
  const godownId = (await godownIdByName(text(h.godown))) ?? src?.godownId ?? base?.godownId;
  if (!godownId) return fieldErr("godown", "Godown is required");
  await db.transaction(async (tx) => {
    if (from.existing) {
      await tx.update(erpTests).set(values).where(eq(erpTests.id, id));
    } else {
      await tx.insert(erpTests).values({
        id,
        inwardId: src?.id ?? base?.inwardId ?? null,
        prNumber: src?.prNumber ?? base!.prNumber,
        rawMaterialId,
        supplierId: src?.supplierId ?? base?.supplierId ?? null,
        godownId,
        unit: src?.unit ?? base?.unit ?? mat.unit,
        quantity: src?.quantity ?? base?.quantity ?? null,
        drums: src?.drums ?? base?.drums ?? null,
        weightWithDrum: src?.weightWithDrum ?? base?.weightWithDrum ?? null,
        tests,
        createdById: ctx.user.id,
        ...values,
      });
    }
    await bindErpFiles(tx as unknown as typeof db, Object.values(photoIds), "erp_test", id, ctx.user.id);
  });
  await erpAudit(ctx, from.existing ? "erp.test.edit" : "erp.test.create", "erp_test", id, null, { tests });
  return okVoid(`Test saved for ${mat.name} · waiting for the verifier`);
}

/* ============================================================ register */

type RegRow = {
  p: typeof erpPurchases.$inferSelect;
  supplier: string;
  partyCode: string | null;
  gstin: string | null;
  item: string;
  itemCode: string | null;
  type: string;
  godown: string;
  by: string | null;
};

/** Register rows, read under `where` — a window, one id, or a godown's chemicals; never the whole register. */
async function registerRows(where: SQL): Promise<RegRow[]> {
  return (await db
    .select({
      p: erpPurchases,
      supplier: erpSuppliers.name,
      partyCode: erpSuppliers.partyCode,
      gstin: erpSuppliers.gstin,
      item: erpRawMaterials.name,
      itemCode: erpRawMaterials.code,
      type: erpRawMaterials.materialType,
      godown: erpGodowns.name,
      by: users.name,
    })
    .from(erpPurchases)
    .innerJoin(erpSuppliers, eq(erpSuppliers.id, erpPurchases.supplierId))
    .innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpPurchases.rawMaterialId))
    .innerJoin(erpGodowns, eq(erpGodowns.id, erpPurchases.godownId))
    .leftJoin(users, eq(users.id, erpPurchases.createdById))
    .where(where)
    .orderBy(desc(erpPurchases.purchaseDate), desc(erpPurchases.prNumber))) as RegRow[];
}

async function purchaseForm(ctx: ErpContext, id?: string): Promise<FormSpec | null> {
  const [gds, sups] = await Promise.all([godownOptions(ctx, { lost: false }), db.select().from(erpSuppliers).orderBy(asc(erpSuppliers.name))]);
  const mats = await db.select().from(erpRawMaterials).orderBy(asc(erpRawMaterials.name));
  let editing: RegRow | undefined;
  if (id) {
    [editing] = await registerRows(eq(erpPurchases.id, id));
    if (!editing) return null;
  }
  const rx = await receivable(ctx.powers.has("viewPurchaseMoney"), editing?.p.poId ? [editing.p.poId] : []);
  const money = ctx.powers.has("viewPurchaseMoney");
  const partyCode: Record<string, string> = {};
  sups.forEach((s) => (partyCode[s.name] = s.partyCode ?? ""));
  const partyOfPo: Record<string, string> = {};
  const rateOf: Record<string, string> = {};
  const gstOf: Record<string, string> = {};
  const unitOfLine: Record<string, string> = {};
  rx.byLabel.forEach((p, label) => {
    partyOfPo[label] = sups.find((s) => s.id === p.po.supplierId)?.partyCode ?? "";
    p.lines.forEach((l) => {
      const key = `${label}|${l.label}`;
      rateOf[key] = rupeesField(l.ratePaise);
      gstOf[key] = String(l.gstBp / 100);
      unitOfLine[key] = l.unit;
    });
  });
  const itemCode: Record<string, string> = {};
  const densityOf: Record<string, number | null> = {};
  mats.forEach((m) => {
    itemCode[m.name] = m.code ?? "";
    densityOf[m.name] = m.density;
  });
  let init: Record<string, string> = {
    date: today(),
    godown: ctx.workingGodown?.name ?? "",
    gst: "18",
    company: "Mahek Marketing India",
  };
  if (editing) {
    const p = editing.p;
    init = {
      pr: String(p.prNumber),
      date: p.purchaseDate,
      ...poLineLabelOf(rx, p.poId, p.poLineId),
      supplier: editing.supplier,
      item: editing.item,
      qty: String(p.quantity),
      unit: p.unit,
      rate: rupeesField(p.ratePaise),
      density: p.density == null ? "" : String(p.density),
      drums: p.drums == null ? "" : String(p.drums),
      weight: p.weightWithDrum == null ? "" : String(p.weightWithDrum),
      feedLitre: String(p.feedAdjustedLitre ?? 0),
      feedAmount: rupeesField(p.feedAdjustedAmountPaise),
      gst: String(p.gstBp / 100),
      company: p.company,
      billNumber: p.billNumber ?? "",
      notes: p.notes ?? "",
      remark: p.remark ?? "",
      godown: editing.godown,
    };
  }
  const header: FieldSpec[] = [
    { k: "pr", l: "PR number", t: id ? "text" : "num", readOnly: !!id, sec: "Purchase", hint: id ? undefined : "Blank draws the next PR number." },
    { k: "date", l: "Purchase date", t: "date", req: true },
    /* On an edit the PO and its item can be changed too: the party and the item follow the PO line, and the
       lot number is worked out again from them (`retargetReceipt`). A lot from before POs may stay without one. */
    {
      k: "po",
      l: "Purchase order",
      t: "select",
      req: !editing || !!editing.p.poId,
      opts: [...rx.byLabel.keys()],
      hint: editing
        ? editing.p.poId
          ? "Changing the PO or its item changes the party and the item, and the lot number with them."
          : "Bought before POs were kept in the ERP. Pick one to put it on a PO."
        : rx.byLabel.size
          ? "No purchase without a PO: a lot entered by hand is bought on a PO's item."
          : "No PO is waiting for goods — link or create it on the requirement first.",
    },
    { k: "poLine", l: "PO item", t: "select", req: !editing || !!editing.p.poId, optsBy: { by: "po", map: rx.linesBy } },
    { k: "pending", l: "Against the PO", t: "derived", calc: "register.pending", when: { k: "poLine", notEmpty: true } },
    { k: "supplier", l: "Party", t: "derived", calc: "inward.supplier" },
    { k: "item", l: "Raw item", t: "select", req: true, readOnly: true, opts: mats.map((m) => m.name), fillBy: { by: ["po", "poLine"], map: rx.itemOf } },
    { k: "lot", l: "Raw-material lot no", t: "derived", calc: "register.lot" },
    { k: "qty", l: "Quantity", t: "num", req: true, min: 0.001, sec: "Quantity", qtyUnit: { of: "unit" }, ...(id ? {} : { fillBy: { by: ["po", "poLine"], map: rx.qtyOf } }) },
    { k: "unit", l: "Unit", t: "select", req: true, opts: ["Kg", "Litre", "Pcs"], hint: "What the lot is kept in. The quantity can be typed in any unit of this kind — drums, grams, tonnes.", ...(id ? {} : { fillBy: { by: ["po", "poLine"], map: unitOfLine } }) },
    /* A kilogram purchase is turned into litres by its density, and the save refuses one without it. */
    { k: "density", l: "Density", t: "num", min: 0, reqWhen: { k: "unit", eq: "Kg" } },
    { k: "drums", l: "No. of drum", t: "num", min: 0, qtyUnit: { base: "drums" } },
    { k: "weight", l: "Weight with drum", t: "num", min: 0, qtyUnit: { base: "Kg" } },
    { k: "litres", l: "In litre", t: "derived", calc: "register.litres" },
    { k: "feedLitre", l: "Feed-adjusted litre", t: "num", min: 0, qtyUnit: { base: "Litre" } },
    { k: "avail", l: "Available litres", t: "derived", calc: "register.available" },
    ...(money
      ? ([
          {
            k: "rate",
            l: "Rate (₹)",
            t: "num",
            min: 0,
            sec: "Money",
            hint: "The PO's rate, until the supplier's bill says otherwise. Stock posts once a rate above zero is entered.",
            ...(id ? {} : { fillBy: { by: ["po", "poLine"], map: rateOf } }),
          },
          { k: "gst", l: "GST %", t: "num", min: 0, max: 100, ...(id ? {} : { fillBy: { by: ["po", "poLine"], map: gstOf } }) },
          /* Taken OFF the bill amount, so a minus figure adds to it: the form only
             lets a number below zero through where `min` is below zero itself. */
          { k: "feedAmount", l: "Feed-adjusted amount (₹)", t: "num", min: Number.MIN_SAFE_INTEGER, hint: "Taken off the final amount. Enter a minus figure (−5) to add it instead." },
          { k: "final", l: "Final amount", t: "derived", calc: "register.final" },
          { k: "company", l: "Company", t: "select", req: true, opts: ["Mahek Marketing India", "MYLAC"] },
        ] as FieldSpec[])
      : []),
    { k: "billNumber", l: "Bill number", t: "text" },
    { ...godownField(gds), sec: "Godown and notes" },
    { k: "notes", l: "Notes", t: "area", mic: true },
    { k: "remark", l: "Remark", t: "area", mic: true },
  ];
  return {
    screen: "register",
    id: id ? "edit" : "new",
    recordId: id,
    title: id ? "Edit purchase" : "New purchase",
    sub: id ? `${editing!.item} · lot ${editing!.p.lotNo}` : "A lot entered by hand against a PO.",
    submit: id ? "Save purchase" : "Add purchase",
    init,
    data: { partyCode, partyOfPo, itemCode, densityOf, supplierOf: rx.supplierOf, pendingOf: rx.pendingOf },
    header,
  };
}

/**
 * WHERE A PURCHASE HAS GOT TO, as one line. Mahek Plus carried three answers
 * — the test's verdict, a purchase status and a separate "bill received"
 * toggle — which could disagree (Purchase Matched with no bill). They are one
 * progress now: Arrived (or Tested) → Bill received → Matched → Verified, and
 * the bill and the status move together (see the actions below).
 */
export function purchaseStage(p: { status: string; billReceived: string | null; testId: string | null }): string {
  if (p.status === "Purchase Verified") return "Verified";
  if (p.status === "Purchase Matched") return "Matched";
  if (p.status === "Invoice Received" || p.billReceived === "Received") return "Bill received";
  return p.testId ? "Tested" : "Arrived";
}

/** The statuses that say a bill is in hand. */
const BILLED = ["Invoice Received", "Purchase Matched", "Purchase Verified"];
/** The stages past the bill (`purchaseStage`). */
const BILLED_STAGES = new Set(["Bill received", "Matched", "Verified"]);

/**
 * Landing cost on a register row: material (before GST, the stock rate's own
 * basis) + its share of the PR's transport and other inward cost. A PR whose
 * transport nobody recorded says so rather than reading as free delivery.
 */
function landingFields(materialPaise: number | null, l: LotLanding | undefined, recorded: boolean) {
  const share = (v: number | undefined) => (v == null ? "—" : inr(v));
  return [
    { l: "Material cost", v: materialPaise == null ? "—" : inr(materialPaise), der: true },
    { l: "Transport (share)", v: recorded ? share(l?.transportSharePaise ?? 0) : "Not recorded on the inward", der: true },
    { l: "Other inward cost (share)", v: recorded ? share(l?.otherSharePaise ?? 0) : "—", der: true },
    { l: "Landing cost", v: materialPaise == null ? "Enter a rate" : inr(l?.landingPaise ?? materialPaise), der: true },
  ];
}

const REGISTER_WINDOW = { label: "Purchase date", default: REGISTER_DEFAULT } as const;

const register: ScreenModule = {
  key: "register",
  window: REGISTER_WINDOW,
  async load(ctx, s) {
    const sc = s ?? unscoped();
    const where = windowWhere(sql`${erpPurchases.purchaseDate}`, sql`${erpPurchases.id}`, sc);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(erpPurchases).where(where);
    const wide = tooWide(Number(n), sc);
    const [rows, pairs, landings, prCosts] = await Promise.all([wide ? Promise.resolve([] as RegRow[]) : registerRows(where), refValues("shortLabel"), lotLandings(), db.select({ pr: erpPrCosts.prNumber }).from(erpPrCosts)]);
    const costed = new Set(prCosts.map((c) => c.pr));
    /* The GRN line each lot came from — its own, or its test's — so Void line is offered here as on the GRN tab. */
    const viaTest = rows.filter((r) => !r.p.inwardId && r.p.testId).map((r) => r.p.testId!);
    const testInward = new Map(
      (viaTest.length ? await db.select({ id: erpTests.id, inward: erpTests.inwardId }).from(erpTests).where(inArray(erpTests.id, viaTest)) : []).map((t) => [t.id, t.inward]),
    );
    const lineIds = rows.map((r) => r.p.poLineId).filter((x): x is string => !!x);
    const poRate = new Map(
      (lineIds.length ? await db.select({ id: erpPoLines.id, rate: erpPoLines.ratePaise }).from(erpPoLines).where(inArray(erpPoLines.id, lineIds)) : []).map((l) => [l.id, l.rate]),
    );
    const byPr = new Map<number, number>();
    rows.forEach((r) => {
      const f = purchaseFigures(figIn(r.p));
      if (f.finalPaise != null) byPr.set(r.p.prNumber, (byPr.get(r.p.prNumber) ?? 0) + f.finalPaise);
    });
    const newForm = await purchaseForm(ctx);
    const money = ctx.powers.has("viewPurchaseMoney");
    const verifier = ctx.powers.has("verifyPurchase");
    const { featureState, pendingFor } = await import("../ai");
    const aiBills = (await featureState("bills", true)).on || (await pendingFor("bills")).size > 0;
    const pendingBills = await pendingFor("bills");
    const reopen = ctx.powers.has("reopenPurchase");
    /* The design's columns first (Lot no, PR · PO, Item, Quantity, PO rate,
       Amount, Received, Flags) — what does not fit folds into the record. */
    const all: Col[] = [
      { k: "lot", l: "Lot no", t: "mono", w: 112 },
      { k: "prPo", l: "PR · PO", t: "mono", w: 128 },
      { k: "item", l: "Item", t: "b" },
      { k: "qty", l: "Quantity", t: "n", uk: "unit" },
      { k: "poRate", l: "PO rate", t: "m", pw: "viewPurchaseMoney" },
      { k: "final", l: "Amount", t: "m", whole: true, pw: "viewPurchaseMoney" },
      { k: "date", l: "Received", t: "d" },
      { k: "f", l: "Flags", t: "f" },
      { k: "party", l: "Party", t: "t" },
      { k: "rate", l: "Rate", t: "m", pw: "viewPurchaseMoney" },
      { k: "gst", l: "GST %", t: "n", pw: "viewPurchaseMoney" },
      { k: "landing", l: "Landing cost", t: "m", pw: "viewPurchaseMoney" },
      { k: "stage", l: "Stage", t: "s", pw: "viewPurchaseMoney" },
      { k: "billNo", l: "Bill no", t: "t" },
      { k: "posting", l: "Inventory", t: "s" },
      { k: "pr", l: "PR no", t: "mono" },
      { k: "po", l: "PO", t: "mono" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "gstin", l: "GSTIN", t: "mono" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    return {
      spec: {
        screen: "register",
        cols,
        hidden,
        /* BY PARTY: one bill comes from one party, so the party is the group,
           its heading says the lots, the total on the bill and its GSTIN, and
           Record bill for n lots runs the bulk Record the bill over that
           party's lots in the open sub-tab (`groupBulk`). */
        groups: ["party"],
        groupHead: ["gstin"],
        groupNoun: ["lot", "lots"],
        groupBulk: money ? { id: "billReceived", l: "Record bill for {n} {noun}" } : undefined,
        subtabs: [
          /* Bill to come and Matched read the stage, which needs purchase money; without it they would always read 0. */
          ...(money ? [{ id: "billToCome", l: "Bill to come", k: "stage", in: ["Arrived", "Tested"], hint: "In the godown, the supplier's bill not yet received" }] : []),
          { id: "rateMissing", l: "Rate missing", flag: "rateMissing", hint: "Held out of stock until the rate is entered" },
          { id: "rateOff", l: "Rate differs", flag: "rateOffPo", hint: "The rate on the lot is not the PO line's" },
          ...(money ? [{ id: "matched", l: "Matched", k: "matched", in: ["yes"], hint: "Bill in hand, rate entered and agreeing with the PO" }] : []),
          { id: "all", l: "Every lot" },
        ],
        agg: money ? { k: "final", l: "on the bill" } : undefined,
        godownKey: "godown",
        /* The money cards drop out on their own where the power withholds the column. */
        stats: [
          { l: "Lots" },
          { l: "On the bill", kind: "sum", k: "final", missing: "without a rate" },
          { l: "Parties", kind: "distinct", k: "party" },
          { l: "Rate differs from PO", where: { flag: "rateOffPo" }, tone: "danger" },
        ],
        filters: ["party", "item", "stage", "posting", "unit", "final"],
        newForm: newForm ?? undefined,
        newLabel: "New purchase",
        /* WHAT A SELECTION CAN DO, BY ITS SHAPE. One bill comes from one party,
           so Record the bill waits for one party's lots; one rate fits one item
           in one unit; a supplier bill is read against one PR's rows. The rest
           is line by line and any selection takes it. */
        bulk: [
          { id: "combined", l: "Combined view", client: "combinedView", fits: false },
          ...(money
            ? [
                {
                  id: "rate",
                  l: "Enter rate",
                  same: ["item", "unit"],
                  prompt: {
                    title: "Enter the purchase rate",
                    sub: "One rate goes on every ticked lot of this item that has no rate yet, and each posts to stock.",
                    submit: "Save rate and post",
                    fields: [{ k: "rate", l: "Rate per unit (₹)", t: "num" as const, req: true, min: 0.01 }],
                  },
                },
                {
                  id: "billReceived",
                  l: "Record the bill",
                  same: ["party"],
                  prompt: {
                    title: "Record the bill",
                    sub: "This bill number goes on every selected purchase that has no bill yet. One bill comes from one party.",
                    submit: "Save",
                    fields: [{ k: "billNo", l: "Bill number", t: "text" as const, req: true }],
                  },
                },
                ...(aiBills ? [{ id: "aiBillRead", l: "Read supplier bill", same: ["pr"], asRow: true }] : []),
                ...(verifier ? [{ id: "verifyMany", l: "Verify purchase", fits: "status", confirm: "Set every selected purchase to Purchase Verified?" }] : []),
                /* A verifier's one status is Purchase Verified, which Verify purchase already is. */
                ...(verifier
                  ? []
                  : [
                      {
                        id: "status",
                        l: "Change status",
                        prompt: {
                          title: "Purchase status",
                          sub: "Every ticked purchase takes this status. Purchase Verified is set by the verifier.",
                          submit: "Save status",
                          fields: [{ k: "status", l: "Status", t: "select" as const, req: true, opts: settableStatuses(false) }],
                        },
                      },
                    ]),
                { id: "billNotReceived", l: "Bill Not Received", confirm: "Mark every ticked purchase as bill not received? A purchase matched to its bill keeps it." },
                { id: "reopen", l: "Back to pending", confirm: "Set every ticked verified purchase back to Pending?" },
              ]
            : []),
        ],
        combined: {
          cols: ["pr", "lot", "item", "qty", "unit", "rate", "gst", "final", "landing", "stage", "billNo", "posting"],
          facts: ["party", "pr", "po", "billNo", "date"],
          totals: [
            { l: "Lots" },
            { l: "On the bill", kind: "sum", k: "final", missing: "without a rate" },
            { l: "Landing cost", kind: "sum", k: "landing", missing: "without a landing cost" },
            { l: "Rate missing", where: { flag: "rateMissing" }, tone: "danger" },
            { l: "Rate differs from PO", where: { flag: "rateOffPo" }, tone: "warn" },
            { l: "Bill to come", where: { k: "stage", in: ["Arrived", "Tested"] }, tone: "warn" },
          ],
          sumBy: { k: "qty", by: "unit", l: "Quantity" },
          words: { pr: "PR", party: "party", item: "item" },
        },
        noDataLine: "No purchases yet. Rows arrive as goods are received against a PO.",
      },
      tooWide: wide,
      rows: rows.map((r) => {
        const p = r.p;
        const f = purchaseFigures(figIn(p));
        const posted = postsToStock(p.ratePaise);
        const rateOff = !!p.poId && !!p.poLineId && poRate.has(p.poLineId) && p.ratePaise != null && p.ratePaise !== poRate.get(p.poLineId);
        const actions: ActionSpec[] = [];
        /* The ⋯ menu, in the design's order: open it and its ordinary work, then the changes, then the take-backs (`menuBlock`). */
        actions.push({ id: "trace", l: "Trace this lot", href: erpTraceHref(p.lotNo) });
        actions.push({ id: "inquiry", l: "Stock inquiry", href: erpStockInquiryHref({ stage: "rm", item: p.rawMaterialId, godown: p.godownId }) });
        actions.push({ id: "label", l: "Print drum label", href: erpLabelsHref({ purchase: p.id }) });
        if (money && aiBills && !pendingBills.has(p.id))
          actions.push({
            id: "aiBillRead",
            l: "Read supplier bill",
            ai: true,
            prompt: {
              title: "Read the supplier bill",
              sub: `PR ${p.prNumber} · ${r.supplier}. The bill is read and matched to this PR's rows; you review every value before anything is saved.`,
              submit: "Read the bill",
              fields: [
                { k: "photo", l: "Bill photo or PDF", t: "photo", req: true },
                { k: "photo2", l: "Second page", t: "photo" },
              ],
            },
          });
        actions.push({ id: "edit", l: "Edit lot", loadsForm: true });
        /* A lot with no rate is held out of stock: entering it is the row's one next step. */
        if (money && !posted)
          actions.push({
            id: "rate",
            l: "Enter rate",
            primary: true,
            prompt: {
              title: "Enter the purchase rate",
              sub: `${r.item} · ${p.lotNo} · ${nf(p.quantity)} ${p.unit}`,
              submit: "Save rate and post",
              fields: [{ k: "rate", l: `Rate per ${p.unit} (₹)`, t: "num", req: true, min: 0.01 }],
            },
          });
        if (money) {
          if (p.billReceived !== "Received")
            actions.push({
              id: "billReceived",
              l: "Bill received",
              prompt: { title: "Bill received", submit: "Save", fields: [{ k: "billNo", l: "Bill number", t: "text", req: true }], init: { billNo: p.billNumber ?? "" } },
            });
          else actions.push({ id: "billNotReceived", l: "Bill not received", why: p.status === "Purchase Matched" || p.status === "Purchase Verified" ? "It has been matched to its bill" : "" });
          actions.push({
            id: "status",
            l: verifier ? "Set status — Purchase Verified" : "Set status",
            /* A verifier's one choice is Purchase Verified, so a verified row has nothing left to set. This `why` is also what tells the selection bar it cannot take Verify purchase. */
            why: verifier && p.status === "Purchase Verified" ? "Already Purchase Verified" : "",
            prompt: {
              title: "Purchase status",
              sub: verifier ? "The verifier sets Purchase Verified." : "Purchase Verified is set by the verifier.",
              submit: "Save status",
              fields: [{ k: "status", l: "Status", t: "select", req: true, opts: settableStatuses(verifier) }],
            },
          });
        }
        if (money && aiBills && pendingBills.has(p.id)) {
          actions.push({ id: "aiBill", l: "Review bill reading", ai: true, loadsForm: true });
          actions.push({ id: "aiBillReject", l: "Reject bill reading", confirm: "Reject the AI reading of this bill? Nothing on the register changes." });
        }
        const inwardId = p.inwardId ?? (p.testId ? (testInward.get(p.testId) ?? null) : null);
        actions.push({
          id: "void",
          l: "Void this lot…",
          why: !inwardId ? "This lot was entered on the register, not received on a GRN — Edit it instead." : mayVoidInward(ctx) ? "" : VOID_WHY,
          prompt: {
            title: `Void ${r.item} on PR ${p.prNumber}?`,
            sub: "Voids the GRN line this lot was received on, for a line received in error. The modal that follows says what goes with it; anything that already used the lot stops it.",
            submit: "Next",
            fields: [{ k: "reason", l: "Why is this line void?", t: "area", req: true }],
          },
          ...(inwardId ? { impact: { kind: "erp-inward-void", id: inwardId } } : {}),
        });
        if (money && (p.status === "Purchase Verified" || p.status === ""))
          actions.push({ id: "reopen", l: "Back to pending", why: reopen ? "" : "Only an admin sets a verified purchase back to Pending" });
        const moneyFields = money
          ? [
              { l: "Litre rate", v: f.literRatePaise == null ? "—" : inr(f.literRatePaise), der: true },
              { l: "Sub total", v: f.subTotalPaise == null ? "—" : inr(f.subTotalPaise), der: true },
              { l: "GST amount", v: f.gstPaise == null ? "—" : inr(f.gstPaise), der: true },
              { l: "Amount + GST", v: f.amountWithGstPaise == null ? "—" : inr(f.amountWithGstPaise), der: true },
              ...landingFields(f.subTotalPaise, landings.get(p.lotNo), costed.has(p.prNumber)),
              { l: "Feed-adjusted amount", v: inr(p.feedAdjustedAmountPaise) },
              { l: "This bill final amount", v: byPr.has(p.prNumber) ? inr(roundedTotal(byPr.get(p.prNumber)!)) : "—", der: true },
              { l: "PO rate", v: p.poLineId && poRate.has(p.poLineId) ? inr(poRate.get(p.poLineId)!) : "—" },
              { l: "Company", v: p.company },
              { l: "Status", v: p.status },
            ]
          : [];
        return {
          id: p.id,
          v: withoutHidden(
            {
              date: p.purchaseDate,
              pr: String(p.prNumber),
              po: p.poNumber,
              prPo: [`PR-${p.prNumber}`, p.poNumber].filter(Boolean).join(" · "),
              poRate: p.poLineId && poRate.has(p.poLineId) ? poRate.get(p.poLineId)! : null,
              gstin: r.gstin,
              lot: p.lotNo,
              party: r.supplier,
              item: r.item,
              qty: p.quantity,
              unit: p.unit,
              rate: p.ratePaise,
              gst: p.gstBp / 100,
              final: f.finalPaise,
              landing: landings.get(p.lotNo)?.landingPaise ?? f.subTotalPaise,
              stage: purchaseStage(p),
              billNo: p.billNumber,
              posting: posted ? "Posted" : "Not posted: rate missing",
              godown: r.godown,
              /* Matched: the bill is in hand and the rate is entered and agrees with the PO — nothing left to chase. */
              matched: money && BILLED_STAGES.has(purchaseStage(p)) && !!p.ratePaise && p.ratePaise > 0 && !rateOff ? "yes" : null,
            },
            hiddenKeys,
          ),
          flags: [
            ...(p.ratePaise && p.ratePaise > 0 ? [] : ["rateMissing"]),
            ...(p.aiFilled ? ["aiFilled"] : []),
            ...(!p.poId ? ["noPo"] : rateOff ? ["rateOffPo"] : []),
          ],
          title: r.item,
          ref: `PR-${p.prNumber} · ${r.supplier}`,
          header: `Lot ${p.lotNo} · ${r.godown}`,
          fields: [
            { l: "Party code", v: r.partyCode ?? "—" },
            { l: "Item code", v: r.itemCode ?? "—" },
            { l: "Material type", v: r.type },
            { l: "Density", v: p.density == null ? "—" : String(p.density) },
            { l: "Drums", v: p.drums == null ? "—" : nf(p.drums) },
            { l: "In litre", v: nf(f.inLitre), der: true },
            { l: "Feed-adjusted litre", v: nf(p.feedAdjustedLitre) },
            { l: "Available litres", v: nf(f.availableLitres), der: true },
            { l: "Litres per drum", v: f.litresPerDrum == null ? "—" : nf(f.litresPerDrum), der: true },
            { l: "Short label name", v: shortLabel(r.item, pairs), der: true },
            { l: "PR / bill", v: prBillLabel(p.prNumber, p.billNumber, p.purchaseDate), der: true },
            { l: "Godown", v: r.godown },
            { l: "Notes", v: p.notes || "—" },
            { l: "Remark", v: p.remark || "—" },
            ...moneyFields,
          ],
          hiddenFields: money ? 0 : 9,
          actions,
          by: stampLine(r.by, p.createdAt),
        };
      }),
    };
  },
  formLoaders: {
    edit: (ctx, id) => purchaseForm(ctx, id),
    aiBill: async (_ctx, id) => (await import("../ai-bills")).billReviewForm(id),
    addMore: async (ctx, id) => {
      const f = await purchaseForm(ctx, id);
      if (!f) return null;
      /* Add More: a new lot on the same PR, header carried over. */
      const keep = ["pr", "date", "godown", "company", "billNumber"];
      const init: Record<string, string> = {};
      keep.forEach((k) => (init[k] = f.init?.[k] ?? ""));
      const base = await purchaseForm(ctx);
      if (!base) return null;
      /* The same PR and, while it can still take goods, the same PO. */
      const [row] = await db.select({ po: erpPurchases.poId }).from(erpPurchases).where(eq(erpPurchases.id, id));
      const [po] = row?.po ? await purchaseOrderViews({ ids: [row.po] }) : [];
      const poText = po && RECEIVABLE_PO.includes(po.po.status) ? poOption(po) : "";
      return { ...base, title: `Add another lot to PR ${init.pr}`, init: { ...base.init, ...init, po: poText } };
    },
  },
  forms: {
    async new(ctx, h) {
      return savePurchase(ctx, h);
    },
    async edit(ctx, h, _l, id) {
      return savePurchase(ctx, h, id);
    },
    async aiBill(ctx, h, lines, suggestionId) {
      if (!suggestionId) return err("No reading named.", "not_found");
      return (await import("../ai-bills")).applyBill(ctx, suggestionId, h, lines);
    },
  },
  actions: {
    async aiBillRead(ctx, id, values) {
      const files = [text(values.photo), text(values.photo2)].filter((x): x is string => !!x);
      return (await import("../ai-bills")).readBill(ctx, id, files);
    },
    async aiBillReject(ctx, id) {
      return (await import("../ai-bills")).rejectBill(ctx, id);
    },
    async rate(ctx, id, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      const rate = paise(values.rate);
      if (rate == null || rate <= 0) return fieldErr("rate", "Rate is required");
      let posted = false;
      await db.transaction(async (tx) => {
        await tx.update(erpPurchases).set({ ratePaise: rate, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
        await refreshCache(tx, id);
        posted = await syncPurchaseEntry(tx, id);
      });
      await erpAudit(ctx, "erp.purchase.rate", "erp_purchase", id, null, { ratePaise: rate });
      const [p] = await db.select().from(erpPurchases).where(eq(erpPurchases.id, id));
      return okVoid(posted ? `Posted · ${nf(p.availableLitres)} of lot ${p.lotNo} now in stock` : "Rate saved");
    },
    async billReceived(ctx, id, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      const billNo = text(values.billNo);
      if (!billNo) return fieldErr("billNo", "Bill number is required");
      /* A bill in hand is the Invoice Received step, not a second flag beside it. */
      await db
        .update(erpPurchases)
        .set({ billReceived: "Received", billNumber: billNo, status: sql`case when ${erpPurchases.status} = 'Pending' then 'Invoice Received' else ${erpPurchases.status} end`, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpPurchases.id, id));
      await erpAudit(ctx, "erp.purchase.billReceived", "erp_purchase", id, null, { billNo });
      return okVoid(`Bill ${billNo} recorded`);
    },
    async billNotReceived(ctx, id) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      const [p] = await db.select({ status: erpPurchases.status }).from(erpPurchases).where(eq(erpPurchases.id, id));
      if (!p) return err("That purchase no longer exists.", "not_found");
      if (p.status === "Purchase Matched" || p.status === "Purchase Verified") return err("A purchase matched to its bill has its bill.", "rule_violation");
      await db
        .update(erpPurchases)
        .set({ billReceived: "Bill Not Received", status: p.status === "Invoice Received" ? "Pending" : p.status, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpPurchases.id, id));
      await erpAudit(ctx, "erp.purchase.billNotReceived", "erp_purchase", id);
      return okVoid("Marked bill not received");
    },
    async status(ctx, id, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      const status = text(values.status);
      const allowed = settableStatuses(ctx.powers.has("verifyPurchase"));
      if (!status || !allowed.includes(status)) return fieldErr("status", status === "Purchase Verified" ? "Only the verifier sets Purchase Verified" : "Pick a status");
      /* Past Pending, the bill is in hand — the one line cannot say Matched and "no bill". */
      await db
        .update(erpPurchases)
        .set({ status, ...(BILLED.includes(status) ? { billReceived: "Received" } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpPurchases.id, id));
      await erpAudit(ctx, "erp.purchase.status", "erp_purchase", id, null, { status });
      return okVoid(`Status is ${status}`);
    },
    /** The GRN tab's Void line, reached from the lot: the act is the GRN line's, so it is named by the line the lot came from. */
    async void(ctx, id, values) {
      if (!mayVoidInward(ctx)) return err(VOID_WHY, "not_permitted");
      const [p] = await db.select({ inwardId: erpPurchases.inwardId, testId: erpPurchases.testId }).from(erpPurchases).where(eq(erpPurchases.id, id));
      if (!p) return err("That lot no longer exists.", "not_found");
      const [t] = !p.inwardId && p.testId ? await db.select({ inward: erpTests.inwardId }).from(erpTests).where(eq(erpTests.id, p.testId)) : [];
      const inwardId = p.inwardId ?? t?.inward ?? null;
      if (!inwardId) return err("This lot was entered on the register, not received on a GRN — Edit it instead.", "rule_violation");
      return voidInward(ctx, inwardId, values);
    },
    async reopen(ctx, id) {
      if (!ctx.powers.has("reopenPurchase")) return err("Only an admin sets a verified purchase back to Pending.", "not_permitted");
      await db.update(erpPurchases).set({ status: "Pending", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
      await erpAudit(ctx, "erp.purchase.reopen", "erp_purchase", id);
      return okVoid("Set back to Pending");
    },
  },
  bulk: {
    /* The row action's rule, over a selection: a row that already has its bill keeps its number. */
    async billReceived(ctx, ids, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      const billNo = text(values.billNo);
      if (!billNo) return fieldErr("billNo", "Bill number is required");
      const open = and(inArray(erpPurchases.id, ids), sql`${erpPurchases.billReceived} is distinct from 'Received'`);
      const parties = await db.selectDistinct({ id: erpPurchases.supplierId }).from(erpPurchases).where(open);
      if (!parties.length) return err("These purchases already have their bill.", "rule_violation");
      if (parties.length > 1) return err(`These purchases come from ${parties.length} parties, and one bill comes from one party. Select one party's purchases.`, "rule_violation");
      const done = await db
        .update(erpPurchases)
        .set({ billReceived: "Received", billNumber: billNo, status: sql`case when ${erpPurchases.status} = 'Pending' then 'Invoice Received' else ${erpPurchases.status} end`, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(open)
        .returning({ id: erpPurchases.id });
      await erpAudit(ctx, "erp.purchase.billReceived.bulk", "erp_purchase", null, null, { billNo, ids: done.map((r) => r.id) });
      return okVoid(`Bill ${billNo} recorded on ${counted(done.length, ids.length, "already had a bill")}`);
    },
    /* One rate fits one item in one unit, and only a lot with no rate takes it — the row's rule. */
    async rate(ctx, ids, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      const rate = paise(values.rate);
      if (rate == null || rate <= 0) return fieldErr("rate", "Rate is required");
      const rows = await db.select({ id: erpPurchases.id, item: erpPurchases.rawMaterialId, unit: erpPurchases.unit, ratePaise: erpPurchases.ratePaise }).from(erpPurchases).where(inArray(erpPurchases.id, ids));
      const open = rows.filter((r) => !postsToStock(r.ratePaise));
      if (!open.length) return err("Every ticked lot already has its rate.", "rule_violation");
      if (new Set(open.map((r) => `${r.item}|${r.unit}`)).size > 1) return err("One rate fits one item in one unit. Tick one item's lots.", "rule_violation");
      let posted = 0;
      /* All of them or none: a rate on half a bill's lots is harder to put right than a failure. */
      await db.transaction(async (tx) => {
        for (const r of open) {
          await tx.update(erpPurchases).set({ ratePaise: rate, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, r.id));
          await refreshCache(tx, r.id);
          if (await syncPurchaseEntry(tx, r.id)) posted++;
        }
      });
      await erpAudit(ctx, "erp.purchase.rate.bulk", "erp_purchase", null, null, { ratePaise: rate, ids: open.map((r) => r.id) });
      const said = `Rate saved on ${counted(open.length, ids.length, "already had a rate")}`;
      return okVoid(posted ? `${said} · ${posted} posted to stock` : said);
    },
    async status(ctx, ids, values) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      const status = text(values.status);
      const allowed = settableStatuses(ctx.powers.has("verifyPurchase"));
      if (!status || !allowed.includes(status)) return fieldErr("status", status === "Purchase Verified" ? "Only the verifier sets Purchase Verified" : "Pick a status");
      const done = await db
        .update(erpPurchases)
        .set({ status, ...(BILLED.includes(status) ? { billReceived: "Received" } : {}), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(and(inArray(erpPurchases.id, ids), sql`${erpPurchases.status} is distinct from ${status}`))
        .returning({ id: erpPurchases.id });
      if (!done.length) return err(`These purchases are already ${status}.`, "rule_violation");
      await erpAudit(ctx, "erp.purchase.status.bulk", "erp_purchase", null, null, { status, ids: done.map((r) => r.id) });
      return okVoid(`${status}: ${counted(done.length, ids.length, `already ${status}`)}`);
    },
    async billNotReceived(ctx, ids) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      /* The row's rule: a purchase matched to its bill has its bill. */
      const done = await db
        .update(erpPurchases)
        .set({ billReceived: "Bill Not Received", status: sql`case when ${erpPurchases.status} = 'Invoice Received' then 'Pending' else ${erpPurchases.status} end`, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(and(inArray(erpPurchases.id, ids), sql`${erpPurchases.billReceived} = 'Received'`, sql`${erpPurchases.status} not in ('Purchase Matched', 'Purchase Verified')`))
        .returning({ id: erpPurchases.id });
      if (!done.length) return err("None of these has a bill that can be taken off — a purchase matched to its bill keeps it.", "rule_violation");
      await erpAudit(ctx, "erp.purchase.billNotReceived.bulk", "erp_purchase", null, null, { ids: done.map((r) => r.id) });
      return okVoid(`Bill not received: ${counted(done.length, ids.length, "had no bill, or are matched to it")}`);
    },
    async reopen(ctx, ids) {
      if (!ctx.powers.has("reopenPurchase")) return err("Only an admin sets a verified purchase back to Pending.", "not_permitted");
      const done = await db
        .update(erpPurchases)
        .set({ status: "Pending", updatedAt: new Date(), updatedById: ctx.user.id })
        .where(and(inArray(erpPurchases.id, ids), sql`${erpPurchases.status} in ('Purchase Verified', '')`))
        .returning({ id: erpPurchases.id });
      if (!done.length) return err("None of these is verified.", "rule_violation");
      await erpAudit(ctx, "erp.purchase.reopen.bulk", "erp_purchase", null, null, { ids: done.map((r) => r.id) });
      return okVoid(`Back to Pending: ${counted(done.length, ids.length, "not verified")}`);
    },
    async verifyMany(ctx, ids) {
      if (!ctx.powers.has("viewPurchaseMoney")) return err(powerRefusal("viewPurchaseMoney"), "not_permitted");
      if (!ctx.powers.has("verifyPurchase")) return err(powerRefusal("verifyPurchase"), "not_permitted");
      const done = await db
        .update(erpPurchases)
        .set({ status: "Purchase Verified", billReceived: "Received", updatedAt: new Date(), updatedById: ctx.user.id })
        .where(and(inArray(erpPurchases.id, ids), sql`${erpPurchases.status} <> 'Purchase Verified'`))
        .returning({ id: erpPurchases.id });
      if (!done.length) return err("These purchases are already Purchase Verified.", "rule_violation");
      await erpAudit(ctx, "erp.purchase.status.bulk", "erp_purchase", null, null, { status: "Purchase Verified", ids: done.map((r) => r.id) });
      return okVoid(`Purchase Verified: ${counted(done.length, ids.length, "already verified")}`);
    },
  },
};

/** A row act over a selection, line by line: "4 lines sent to Testing · 1 already sent". */
async function eachLine(ids: string[], act: (id: string) => Promise<Result<unknown>>, did: string, leftAlone: string): Promise<Result<unknown>> {
  let done = 0;
  let refusal: Result<unknown> | null = null;
  for (const id of ids) {
    const r = await act(id);
    if (r.ok) done++;
    else refusal ??= r;
  }
  if (!done) return refusal ?? err("Nothing was ticked.", "validation");
  const said = `${done} line${done === 1 ? "" : "s"} ${did}`;
  return okVoid(done < ids.length ? `${said} · ${ids.length - done} ${leftAlone}` : said);
}

/** "3 purchases", and how many of the selection were left alone and why. */
function counted(done: number, chosen: number, leftAlone: string): string {
  const said = `${done} purchase${done === 1 ? "" : "s"}`;
  return done < chosen ? `${said} · ${chosen - done} ${leftAlone}` : said;
}

function figIn(p: typeof erpPurchases.$inferSelect) {
  return {
    quantity: p.quantity,
    unit: p.unit,
    ratePaise: p.ratePaise,
    density: p.density,
    feedAdjustedLitre: p.feedAdjustedLitre,
    feedAdjustedAmountPaise: p.feedAdjustedAmountPaise,
    gstBp: p.gstBp,
    drums: p.drums,
  };
}

/** Rewrites the cached available litres from the row's own figures. */
async function refreshCache(tx: Tx, id: string) {
  const [p] = await tx.select().from(erpPurchases).where(eq(erpPurchases.id, id));
  if (!p) return;
  const f = purchaseFigures(figIn(p));
  await tx.update(erpPurchases).set({ availableLitres: f.availableLitres }).where(eq(erpPurchases.id, id));
}

async function savePurchase(ctx: ErpContext, h: Record<string, string>, id?: string): Promise<Result<unknown>> {
  const money = ctx.powers.has("viewPurchaseMoney");
  const qty = num(h.qty);
  if (qty == null || qty <= 0) return fieldErr("qty", qty != null && qty < 0 ? "Quantity cannot be below 0." : "Quantity is required");
  const unit = text(h.unit);
  if (!unit || !["Kg", "Litre", "Pcs"].includes(unit)) return fieldErr("unit", "Unit is required");
  const godownId = await godownIdByName(text(h.godown));
  if (!godownId) return fieldErr("godown", "Godown is required");
  const density = num(h.density);
  if (unit === "Kg" && (density == null || density <= 0)) return fieldErr("density", "A kilogram purchase needs a density to be turned into litres");
  const common = {
    purchaseDate: text(h.date) ?? today(),
    quantity: qty,
    unit,
    density,
    drums: int(h.drums),
    weightWithDrum: num(h.weight),
    feedAdjustedLitre: num(h.feedLitre) ?? 0,
    billNumber: text(h.billNumber),
    notes: text(h.notes),
    remark: text(h.remark),
    godownId,
    ...(money
      ? {
          ratePaise: paise(h.rate),
          gstBp: Math.round((num(h.gst) ?? 18) * 100),
          feedAdjustedAmountPaise: paise(h.feedAmount) ?? 0,
          company: text(h.company) ?? "Mahek Marketing India",
        }
      : {}),
  };
  if (id) {
    const [before] = await db.select().from(erpPurchases).where(eq(erpPurchases.id, id));
    if (!before) return err("That purchase no longer exists.", "not_found");
    /* The PO line picked on the form; a lot from before POs may leave it blank. */
    let target: { poLineId: string; poId: string } | null = null;
    /* Blank keeps the PO line it is on (and is what an older page sends). */
    if (text(h.po)) {
      const rx = await receivable(money, before.poId ? [before.poId] : []);
      const po = rx.find(text(h.po));
      if (!po) return fieldErr("po", "Pick the purchase order this lot was bought on");
      const line = po.lines.find((l) => l.label === text(h.poLine));
      if (!line) return fieldErr("poLine", "Pick an item on this PO");
      if (line.id !== before.poLineId) target = { poLineId: line.id, poId: po.po.id };
    }
    /* A lot entered by hand IS the receipt against its PO line; like the GRN, it is never refused for its quantity (0357). */
    const res = await inTx(async (tx) => {
      const touched = target ? await retargetReceipt(tx, ctx, { purchaseId: id }, { poLineId: target.poLineId }) : [];
      await tx.update(erpPurchases).set({ ...common, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpPurchases.id, id));
      await refreshCache(tx, id);
      await syncPurchaseEntry(tx, id);
      for (const poId of new Set([...touched, ...(before.source === "manual" && before.poId ? [before.poId] : [])])) await refreshPurchaseOrder(tx, poId);
      const [after] = await tx.select({ lotNo: erpPurchases.lotNo }).from(erpPurchases).where(eq(erpPurchases.id, id));
      return okVoid(after && after.lotNo !== before.lotNo ? `Purchase saved · lot is now ${after.lotNo}` : "Purchase saved");
    });
    if (res.ok) await erpAudit(ctx, "erp.purchase.edit", "erp_purchase", id, before, { ...common, ...(target ? { moved: target } : {}) });
    return res;
  }
  /* A typed PR number is used as typed, so 0 or a negative would be a lot nobody can find by its PR. */
  const typedPr = int(h.pr);
  if (typedPr != null && typedPr < 1) return fieldErr("pr", "A PR number is 1 or more — leave it blank to draw the next one");
  /* NO PURCHASE WITHOUT A PO: the party and the item are the PO line's, never typed. */
  const rx = await receivable();
  const po = rx.find(text(h.po));
  if (!po) return fieldErr("po", "Pick the approved purchase order this lot was bought on");
  const line = po.lines.find((l) => l.label === text(h.poLine));
  if (!line) return fieldErr("poLine", "Pick an item on this PO");
  const terms = poTerms(po.po.poNumber, po.po.id, line);
  /* Without the money power the rate is the PO's. With it, the form opens on the PO's rate and what is
     there on save is the answer — the bill's rate typed over it, or a blank somebody left on purpose. */
  const priced = money ? { ratePaise: paise(h.rate), gstBp: Math.round((num(h.gst) ?? terms.gstBp / 100) * 100) } : { ratePaise: terms.ratePaise, gstBp: terms.gstBp };
  let result: Result<{ id: string; lotNo: string }> | null = null;
  await db
    .transaction(async (tx) => {
      const pr = typedPr ?? (await nextNumber(tx, "pr"));
      result = await createPurchase(tx, ctx, {
        ...common,
        ...terms,
        ...priced,
        prNumber: pr,
        supplierId: po.po.supplierId,
        rawMaterialId: line.rawMaterialId,
        source: "manual",
      });
      if (!result.ok) tx.rollback();
      else await refreshPurchaseOrder(tx, po.po.id);
    })
    .catch((e: unknown) => (e instanceof Error && e.message === "Rollback" ? null : Promise.reject(e)));
  const r = result as Result<{ id: string; lotNo: string }> | null;
  if (!r) return err("Could not save the purchase.");
  if (!r.ok) return r;
  await erpAudit(ctx, "erp.purchase.create", "erp_purchase", r.data.id, null, common);
  return okVoid(`Purchase saved · lot ${r.data.lotNo}`);
}

/* ============================================================= barcode */

/**
 * DRUM LABELS: TO PRINT · PRINTED (Nov 2026). Every print of a lot's drum
 * labels is a row in `erp_label_prints` (0373), written by the label page
 * where it actually printed, reprints included — so To print is a chemical
 * lot never printed and Printed says when, by whom and how many times. Lots
 * bought before the print log carry no row and read as To print, which is
 * why both sub-tabs keep the period (opening on the last seven days).
 *
 * It lists every godown the person is assigned to, not only the working one:
 * labels are printed for the lots at the godowns somebody works, and an empty
 * list because the header said another godown was the commonest dead end on
 * this page. The godown is a column and a section of the Filters.
 *
 * Print-only: printing is Access, so it has no Edit or Delete acts.
 */
const BARCODE_WINDOW = { label: "Received date", default: REGISTER_DEFAULT } as const;

const barcode: ScreenModule = {
  key: "barcode",
  window: BARCODE_WINDOW,
  async load(ctx, s) {
    const sc = s ?? unscoped();
    const pairs = await refValues("shortLabel");
    const mine = ctx.assignedGodowns.map((g) => g.id);
    const where = sql`${windowWhere(sql`${erpPurchases.purchaseDate}`, sql`${erpPurchases.id}`, sc)} and ${erpRawMaterials.materialType} = 'Chemical' and ${mine.length ? inArray(erpPurchases.godownId, mine) : sql`false`}`;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(erpPurchases).innerJoin(erpRawMaterials, eq(erpRawMaterials.id, erpPurchases.rawMaterialId)).where(where);
    const wide = tooWide(Number(n), sc);
    const rows = wide ? [] : await registerRows(where);
    const prints = await labelPrintsOf(rows.map((r) => r.p.id));
    const cols: ColSpec[] = [
      { k: "date", l: "Received", t: "d" },
      { k: "lot", l: "Lot", t: "mono" },
      { k: "item", l: "Item", t: "b" },
      { k: "drums", l: "Drums", t: "n" },
      { k: "perDrum", l: "Litres per drum", t: "n" },
      { k: "density", l: "Density", t: "n" },
      { k: "pr", l: "PR no", t: "mono" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "lastPrinted", l: "Last printed", t: "at", sub: "printedLine" },
      { k: "prints", l: "Prints", t: "n" },
      { k: "litres", l: "In litre", t: "n" },
      { k: "qty", l: "Quantity", t: "n", uk: "unit" },
      { k: "remark", l: "Remark", t: "t" },
    ];
    return {
      spec: {
        screen: "barcode",
        cols,
        hidden: [],
        readOnly: true,
        subtabs: [
          { id: "toPrint", l: "To print", k: "printed", in: ["no"], hide: ["lastPrinted", "prints"], hint: "Chemical lots whose drum labels have never been printed" },
          { id: "printed", l: "Printed", k: "printed", in: ["yes"], hide: ["perDrum", "density"], hint: "Printed at least once — print again from here" },
        ],
        sortDefault: ["date", -1],
        godownKey: "godown",
        /* The sub-tabs carry the counts; the design draws no figure cards here. */
        stats: [],
        filters: ["item", "godown", "drums"],
        /* Tick lots, print every one's labels in one go: the label page draws them and records the print. */
        bulk: [{ id: "print", l: "Print {n} labels", href: erpLabelsHref({ purchases: [] }), countK: "labels", fits: false }],
        selectSum: [{ k: "labels", l: "labels", one: "label" }],
        noDataLine: "No chemical lots at your godowns in this period.",
      },
      tooWide: wide,
      rows: rows.map((r) => {
        const f = purchaseFigures(figIn(r.p));
        const pr = prints.get(r.p.id);
        const labels = labelCopies(r.p.drums);
        const name = shortLabel(r.item, pairs);
        return {
          id: r.p.id,
          v: {
            printed: pr ? "yes" : "no",
            date: r.p.purchaseDate,
            lot: r.p.lotNo,
            item: name,
            drums: r.p.drums,
            labels,
            perDrum: f.litresPerDrum,
            density: r.p.density,
            pr: `PR-${r.p.prNumber}`,
            godown: r.godown,
            lastPrinted: pr ? pr.at.toISOString() : null,
            printedBy: pr?.by ?? null,
            printedLine: pr ? `${pr.by ?? "—"} · ${nf(pr.n)} print${pr.n === 1 ? "" : "s"}` : null,
            prints: pr?.n ?? null,
            litres: f.inLitre,
            qty: r.p.quantity,
            unit: r.p.unit,
            remark: r.p.remark,
          },
          flags: [],
          title: `${name} · ${r.p.lotNo}`,
          ref: `PR-${r.p.prNumber}`,
          header: `${r.p.drums == null ? "No drum count" : `${nf(r.p.drums)} drum${r.p.drums === 1 ? "" : "s"}`} · ${r.godown}${pr ? ` · printed ${nf(pr.n)}×, last by ${pr.by ?? "—"}` : " · never printed"}`,
          actions: [
            { id: "label", l: "Print drum label", short: `Print ${nf(labels)}`, primary: true, soft: true, href: erpLabelsHref({ purchase: r.p.id }) },
            { id: "trace", l: "Trace this lot", href: erpTraceHref(r.p.lotNo) },
          ],
          by: stampLine(r.by, r.p.createdAt),
        };
      }),
    };
  },
};

/** One label a drum; a lot with no drum count still gets one. */
const labelCopies = (drums: number | null) => Math.max(1, drums ?? 1);

/** Each lot's print log, read once: how many prints, the last one's time and who printed it. */
export async function labelPrintsOf(purchaseIds: string[]): Promise<Map<string, { n: number; at: Date; by: string | null }>> {
  if (!purchaseIds.length) return new Map();
  const rows = (await db.execute(sql`
    select distinct on (lp.purchase_id) lp.purchase_id as id, lp.printed_at as at, u.name as by,
           count(*) over (partition by lp.purchase_id)::int as n
      from erp_label_prints lp
      left join users u on u.id = lp.printed_by_id
     where lp.purchase_id in ${purchaseIds}
     order by lp.purchase_id, lp.printed_at desc
  `)) as unknown as { id: string; at: string | Date; by: string | null; n: number }[];
  /* Raw SQL hands a timestamp back as a string. */
  return new Map(rows.map((r) => [r.id, { n: Number(r.n), at: new Date(r.at), by: r.by }]));
}

/**
 * THE PRINT LOG'S ONE WRITER: the label page printed these lots' labels —
 * sent to the printer, saved as a print file, or the print dialog shown. One
 * row a lot, `reprint` where the lot had been printed before. A lot that is
 * not a purchase is skipped, never invented.
 */
export async function recordLabelPrints(ctx: ErpContext, lots: { id: string; copies: number }[]): Promise<Result<{ recorded: number; reprints: number }>> {
  /* One row a lot: a lot named twice on one page is one print of all its copies. */
  const byLot = new Map<string, number>();
  for (const l of lots) if (typeof l.id === "string" && l.id && Number.isInteger(l.copies) && l.copies > 0) byLot.set(l.id, Math.min(MAX_LABEL_COPIES, (byLot.get(l.id) ?? 0) + l.copies));
  const clean = [...byLot].map(([id, copies]) => ({ id, copies }));
  if (!clean.length) return { ok: true, data: { recorded: 0, reprints: 0 } };
  const ids = [...new Set(clean.map((l) => l.id))];
  const known = new Set((await db.select({ id: erpPurchases.id }).from(erpPurchases).where(inArray(erpPurchases.id, ids))).map((r) => r.id));
  const before = new Set(
    (await db.execute(sql`select distinct purchase_id as id from erp_label_prints where purchase_id in ${ids}`) as unknown as { id: string }[]).map((r) => r.id),
  );
  const rows = clean
    .filter((l) => known.has(l.id))
    .map((l) => ({ id: erpId("lbp"), purchaseId: l.id, copies: l.copies, reprint: before.has(l.id), printedById: ctx.user.id }));
  if (!rows.length) return { ok: true, data: { recorded: 0, reprints: 0 } };
  await db.insert(erpLabelPrints).values(rows);
  const reprints = rows.filter((r) => r.reprint).length;
  await erpAudit(ctx, "erp.purchase.labelPrint", "erp_purchase", rows.slice(0, 50).map((r) => r.purchaseId).join(","), null, { lots: rows.length, reprints, copies: rows.reduce((t, r) => t + r.copies, 0) });
  return { ok: true, data: { recorded: rows.length, reprints } };
}

/* ======================================================== raw stock */

const rmStock: ScreenModule = {
  key: "rmStock",
  window: STOCK_WINDOW,
  async load(ctx, s) {
    const sc = s ?? unscoped();
    /* Every lot that holds something — a can's lot drawn below zero included,
       because its item's total is read across all of them (`stock-fold.ts`). */
    const folded = foldRmLots(await rmLots());
    /* A chemical lot by its own date; an item's total by its newest lot's, and
       kept whole when its total or any of its lots is the one named. */
    const shown = folded.filter((r) =>
      r.kind === "lot"
        ? r.lot.stock > 0 && inWindow(r.lot.latestDate, r.id, sc)
        : r.stock !== 0 &&
          (inWindow(r.lots.reduce((d, l) => (l.latestDate > d ? l.latestDate : d), ""), r.id, sc) ||
            r.lots.some((l) => sc.ids?.includes(lotRowId(l)) || sc.open === lotRowId(l))),
    );
    const wide = tooWide(shown.length, sc, STOCK_ROW_CAP);
    const rowsIn = wide ? [] : shown;
    const all: Col[] = [
      { k: "item", l: "Item", t: "b" },
      { k: "type", l: "Type", t: "t" },
      { k: "stock", l: "Stock", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      { k: "lot", l: "Lot no", t: "mono" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "rate", l: "Rate", t: "m", pw: "viewCost" },
      { k: "value", l: "Value", t: "m", pw: "viewCost" },
    ];
    const { cols, hidden, hiddenKeys } = visibleCols(all, has(ctx));
    type Lot = Awaited<ReturnType<typeof rmLots>>[number];
    const lotRow = (l: Lot, sub: boolean) => ({
      id: lotRowId(l),
      v: withoutHidden(
        {
          item: l.item,
          type: l.materialType,
          stock: l.stock,
          unit: l.unit,
          lot: l.lotNo,
          godown: l.godown,
          rate: l.ratePaise,
          value: l.ratePaise == null ? null : Math.round(l.ratePaise * l.stock),
        },
        hiddenKeys,
      ),
      flags: [],
      title: `${l.item} · ${l.lotNo}`,
      header: sub
        ? `About ${nf(l.stock)} ${l.unit} of this lot at ${l.godown} · received ${fd(l.firstDate)}. Filling and packing do not say which lot they used, so lots are drawn down oldest first: the item's total is exact, this lot's share is an estimate.`
        : `${nf(l.stock)} ${l.unit} at ${l.godown} · last entry ${fd(l.latestDate)}`,
      ...(sub ? { subLine: `Lot ${l.lotNo} · received ${fd(l.firstDate)}` } : {}),
      actions: [
        ...stockRowActions(ctx, { stage: "rm", itemId: l.rawMaterialId, item: l.item, lot: l.lotNo, godownId: l.godownId, godown: l.godown, stock: l.stock, unit: l.unit }),
        { id: "trace", l: "Trace this lot", href: erpTraceHref(l.lotNo) },
      ],
    });
    return {
      spec: {
        screen: "rmStock",
        rowMenu: ["inquiry", "adjust"],
        cols,
        hidden,
        groups: ["godown"],
        godownKey: "godown",
        chips: "type",
        readOnly: true,
        /* Stock itself is not summed: items mix kg, litres and pieces. */
        stats: [
          { l: "Items", kind: "distinct", k: "item" },
          { l: "Lots" },
          { l: "Value", kind: "sum", k: "value", missing: "without a rate" },
        ],
        filters: ["item", "unit", "value"],
        noDataLine: "Nothing in stock yet. Stock appears as purchases are given a rate.",
        fold: {
          l: "Cans & boxes",
          whole: "Item total",
          parts: "By lot",
          note: "Chemicals are shown lot by lot. Cans, boxes and other items are one total per godown — open one to see its lots.",
        },
      },
      tooWide: wide,
      rows: rowsIn.map((r) => {
        if (r.kind === "lot") return lotRow(r.lot, false);
        const l = r.lots[r.lots.length - 1];
        const n = r.lots.length;
        return {
          id: r.id,
          v: withoutHidden(
            { item: l.item, type: l.materialType, stock: r.stock, unit: l.unit, lot: `${n} ${n === 1 ? "lot" : "lots"}`, godown: l.godown, rate: r.ratePaise, value: r.valuePaise },
            hiddenKeys,
          ),
          flags: [],
          title: l.item,
          header: `${nf(r.stock)} ${l.unit} at ${l.godown}, across ${n} ${n === 1 ? "lot" : "lots"}${r.stock < 0 ? " — more has been used than was received" : ""}`,
          fields: r.lots.map((x) => ({ l: `Lot ${x.lotNo}`, v: `${nf(x.stock)} ${x.unit} · received ${fd(x.firstDate)}` })),
          sub: r.lots.map((x) => lotRow(x, true)),
          /* An item's total is many lots: it can be looked into; each lot under it is adjusted on its own row. */
          actions: [{ id: "inquiry", l: "Stock inquiry", href: erpStockInquiryHref({ stage: "rm", item: l.rawMaterialId, godown: l.godownId }) }],
        };
      }),
    };
  },
  actions: {
    adjust: (ctx, id, values) => adjustStockRow(ctx, "rm", id, values ?? {}),
  },
};

const RMLOG_WINDOW = { label: "Entry date", default: REGISTER_DEFAULT } as const;

const rmLog: ScreenModule = {
  key: "rmLog",
  window: RMLOG_WINDOW,
  async load(_ctx, s) {
    const sc = s ?? unscoped();
    const within = windowWhere(sql`e.entry_date`, sql`e.id`, sc);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from erp_rm_entries e where ${within}`)) as unknown as { n: number }[];
    const wide = tooWide(Number(n), sc);
    const rows = wide ? [] : (await db.execute(sql`
      select e.id, e.entry_date::text as date, e.source_type as "sourceType", e.source_id as "sourceId",
             m.name as item, e.lot_no as lot, e.quantity::float8 as qty, g.name as godown, e.posted_at as "postedAt",
             (e.source_type = 'purchase' and not exists (select 1 from erp_purchases p where p.id = e.source_id)) as orphan
        from erp_rm_entries e
        join erp_raw_materials m on m.id = e.raw_material_id
        join erp_godowns g on g.id = e.godown_id
       where ${within}
       order by e.entry_date desc, e.posted_at desc, e.id desc
    `)) as unknown as { id: string; date: string; sourceType: string; sourceId: string; item: string; lot: string; qty: number; godown: string; postedAt: Date; orphan: boolean }[];
    const cols: ColSpec[] = [
      { k: "date", l: "Date", t: "d" },
      { k: "type", l: "Entry", t: "s" },
      { k: "item", l: "Item", t: "b" },
      { k: "lot", l: "Lot", t: "mono" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "godown", l: "Godown", t: "t" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "rmLog",
        cols,
        hidden: [],
        godownKey: "godown",
        readOnly: true,
        stats: [
          { l: "Entries" },
          { l: "Items", kind: "distinct", k: "item" },
          { l: "Lots", kind: "distinct", k: "lot" },
          { l: "Adjusted by hand", where: { k: "type", in: ["Adjusted by hand"] }, tone: "warn" },
          { l: "Source deleted", where: { flag: "orphan" }, tone: "danger" },
        ],
        filters: ["type", "item"],
        sortDefault: ["date", -1],
        noDataLine: "Nothing in this period. Entries appear on their own as purchases and transfers post.",
      },
      tooWide: wide,
      rows: rows.map((r) => ({
        id: r.id,
        v: { date: r.date, type: r.sourceType === "purchase" ? "Purchase" : r.sourceType === "adjustment" ? "Adjusted by hand" : "Transfer", item: r.item, lot: r.lot, qty: Number(r.qty), godown: r.godown, source: r.sourceId },
        flags: r.orphan ? ["orphan"] : [],
        title: `${r.item} · ${r.lot}`,
        by: `Posted ${stampLine(null, r.postedAt).replace(/^Created /, "")}`,
      })),
    };
  },
};

export const PURCHASE_SCREENS: ScreenModule[] = [inward, testing, register, barcode, rmStock, rmLog];
