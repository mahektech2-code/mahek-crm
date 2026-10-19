import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { orderTraceCode } from "../trace-links";
import { db } from "@/db";
import {
  bills,
  complaints,
  erpCustomerReturns,
  erpDebitNotes,
  erpFgEntries,
  erpPackEntries,
  erpPurchaseReturns,
  erpReturnDispositions,
  erpReturnOutwards,
  erpReworkOrders,
  erpScrapEntries,
  erpSfgEntries,
  erpWasteDisposals,
} from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import { createComplaint } from "@/lib/services/complaint-create";
import type { ErpContext } from "../access";
import { bindErpFiles } from "../attachments";
import { bookBillRef } from "../book";
import { scrapStock } from "../drums";
import {
  CHEMICAL_SCRAP,
  CUSTOMER_RETURN_REASONS,
  CUSTOMER_STAGE_LABEL,
  DISPOSITIONS,
  VENDOR_RETURN_REASONS,
  VENDOR_STAGE_LABEL,
  approvalRefusal,
  approvalSteps,
  complaintCategoryFor,
  creditNoteWord,
  customerReturnLabel,
  customerReturnRefusal,
  customerReturnStage,
  debitNoteLabel,
  dispositionByLabel,
  dispositionLabel,
  dispositionRefusal,
  purchaseReturnLabel,
  quarantineLeft,
  reasonByLabel,
  reasonLabel,
  returnLitres,
  returnOutwardLabel,
  returnValue,
  reworkFigures,
  reworkLabel,
  reworkLotCode,
  toStockQty,
  vendorReturnRefusal,
  vendorReturnStage,
  wasteLabel,
  type Disposition,
} from "../engines/returns";
import { erpLink } from "../registry";
import { lineOption, lotOption, moveReturnUnits, returnableLines, returnableLots, valuedQty } from "../returns";
import { erpAudit, erpId, nextNumber, num, paise, stampLine, text, type ScreenModule } from "../server";
import { fgLotStock, lockLot, packLotStock, rmLots } from "../stock";
import type { ActionSpec, ColSpec, FieldSpec, ListRow, RowField } from "../ui";
import { fd, inr, nf } from "../ui";
import { godownIdByName, godownOptions, inTx, refuse, today, type Tx } from "./common";

/* ---------------------------------------------------------------------------
 * MATERIAL RETURNS — two screens, seven tabs.
 *
 *   Vendor returns   · Purchase returns · Debit notes · Return outward
 *   Customer returns · Returns · Quarantine & QC · Rework · Waste disposal
 *
 * Financial documents adjust the ledger; physical transactions adjust stock.
 * A debit note and a credit note move no stock. A confirmed return outward is
 * an outflow of its raw-material lot (`rmLots`). A customer return waits in
 * quarantine — on its own record, outside every saleable stock — until QC
 * posts it into the EXISTING FG, packing, SFG (through a rework) and scrap
 * ledgers, or to waste. Nothing is deleted: a confirmed document is cancelled
 * or reversed with a reason, and the original stays.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const approves = (ctx: ErpContext) => ctx.administrator || ctx.powers.has("returnApprove");
const decidesQc = (ctx: ErpContext) => ctx.administrator || ctx.powers.has("returnQc");
const seesMoney = (ctx: ErpContext) => ctx.administrator || ctx.powers.has("viewPurchaseMoney") || ctx.powers.has("returnApprove");
const ownerLimit = async () => Number((await getConfig())["erp.returns.ownerApprovalPaise"] ?? 0);
const VENDOR_REASON_LABELS = VENDOR_RETURN_REASONS.map((r) => r.label);
const CUSTOMER_REASON_LABELS = CUSTOMER_RETURN_REASONS.map((r) => r.label);
const why = (b: boolean, reason: string) => (b ? "" : reason);

/* ====================================================================
 * VENDOR RETURNS
 * ================================================================== */

type VendorRow = {
  id: string;
  no: number;
  date: string;
  status: string;
  purchaseId: string;
  supplierId: string;
  supplier: string;
  rm: string;
  item: string;
  lot: string;
  pr: number;
  bill: string | null;
  qty: number;
  unit: string;
  stockQty: number;
  rate: number | null;
  gstBp: number;
  amount: number | null;
  tax: number | null;
  total: number | null;
  reason: string;
  remarks: string | null;
  needsOwner: boolean;
  approvedById: string | null;
  approver: string | null;
  approvedAt: Date | null;
  ownerApprover: string | null;
  ownerApprovedAt: Date | null;
  note: string | null;
  cancelReason: string | null;
  requesterId: string | null;
  requester: string | null;
  createdAt: Date;
  dnId: string | null;
  dnNo: number | null;
  dnTotal: number | null;
  outId: string | null;
  outNo: number | null;
  outStatus: string | null;
  outGodown: string | null;
  outDate: string | null;
};

async function vendorRows(where = sql`true`, ex: Tx | typeof db = db): Promise<VendorRow[]> {
  const rows = (await ex.execute(sql`
    select r.id, r.return_no as no, r.return_date::text as date, r.status, r.purchase_id as "purchaseId", r.supplier_id as "supplierId",
           s.name as supplier, r.raw_material_id as rm, m.name as item, r.lot_no as lot, r.pr_number as pr, p.bill_number as bill,
           r.quantity::float8 as qty, r.unit, r.stock_qty::float8 as "stockQty", r.rate_paise::float8 as rate, r.gst_bp as "gstBp",
           r.amount_paise::float8 as amount, r.tax_paise::float8 as tax, r.total_paise::float8 as total, r.reason_code as reason,
           r.remarks, r.needs_owner as "needsOwner", r.approved_by_id as "approvedById", ua.name as approver, r.approved_at as "approvedAt",
           uo.name as "ownerApprover", r.owner_approved_at as "ownerApprovedAt", r.decision_note as note, r.cancel_reason as "cancelReason",
           r.created_by_id as "requesterId", uc.name as requester, r.created_at as "createdAt",
           dn.id as "dnId", dn.note_no as "dnNo", dn.total_paise::float8 as "dnTotal",
           o.id as "outId", o.outward_no as "outNo", o.status as "outStatus", og.name as "outGodown", o.dispatch_date::text as "outDate"
      from erp_purchase_returns r
      join erp_suppliers s on s.id = r.supplier_id
      join erp_raw_materials m on m.id = r.raw_material_id
      join erp_purchases p on p.id = r.purchase_id
      left join users ua on ua.id = r.approved_by_id
      left join users uo on uo.id = r.owner_approved_by_id
      left join users uc on uc.id = r.created_by_id
      left join erp_debit_notes dn on dn.purchase_return_id = r.id and dn.status = 'issued'
      left join erp_return_outwards o on o.purchase_return_id = r.id and o.status <> 'cancelled'
      left join erp_godowns og on og.id = o.godown_id
     where ${where}
     order by r.created_at desc
  `)) as unknown as VendorRow[];
  return rows.map((r) => ({ ...r, no: Number(r.no), pr: Number(r.pr), dnNo: r.dnNo == null ? null : Number(r.dnNo), outNo: r.outNo == null ? null : Number(r.outNo) }));
}

const vStage = (r: VendorRow) =>
  vendorReturnStage({ status: r.status, needsOwner: r.needsOwner, ownerApproved: !!r.ownerApprovedAt }, r.outStatus ? { status: r.outStatus } : null);

/** Issues the debit note an approved return generates — in the approval's own transaction. */
async function issueDebitNote(tx: Tx, ctx: ErpContext, r: VendorRow): Promise<number> {
  const [lot] = (await tx.execute(sql`select rate_paise::float8 as rate, gst_bp as "gstBp", bill_number as bill from erp_purchases where id = ${r.purchaseId}`)) as unknown as { rate: number | null; gstBp: number; bill: string | null }[];
  const v = returnValue({ qty: r.qty, ratePaise: lot?.rate == null ? null : Number(lot.rate), gstBp: Number(lot?.gstBp ?? r.gstBp) });
  if (!v || v.totalPaise <= 0) refuse(err("This lot has no purchase rate yet, so a debit note cannot be written. Rate the lot on the purchase register first.", "rule_violation"));
  const noteNo = await nextNumber(tx, "debitNote");
  await tx.insert(erpDebitNotes).values({
    id: erpId("edn"),
    noteNo,
    noteDate: today(),
    purchaseReturnId: r.id,
    supplierId: r.supplierId,
    purchaseId: r.purchaseId,
    prNumber: r.pr,
    billNumber: lot?.bill ?? null,
    lotNo: r.lot,
    rawMaterialId: r.rm,
    quantity: r.qty,
    unit: r.unit,
    ratePaise: Number(lot!.rate),
    gstBp: Number(lot!.gstBp),
    amountPaise: v!.amountPaise,
    taxPaise: v!.taxPaise,
    totalPaise: v!.totalPaise,
    reasonCode: r.reason,
    createdById: ctx.actor.id,
  });
  await tx.update(erpPurchaseReturns).set({ ratePaise: Number(lot!.rate), gstBp: Number(lot!.gstBp), amountPaise: v!.amountPaise, taxPaise: v!.taxPaise, totalPaise: v!.totalPaise, updatedAt: new Date() }).where(eq(erpPurchaseReturns.id, r.id));
  return noteNo;
}

function vendorActions(ctx: ErpContext, r: VendorRow, stockGodowns: string[]): ActionSpec[] {
  const stage = vStage(r);
  const can = approves(ctx);
  const own = r.requesterId === ctx.user.id && !ctx.administrator;
  const out: ActionSpec[] = [];
  if (stage === "awaiting_approval") {
    out.push({
      id: "approve",
      l: r.needsOwner ? "Approve (the owner approves next)" : "Approve and issue debit note",
      primary: true,
      why: !can ? "Approving a return needs the returns power" : own ? "Somebody other than whoever raised it approves it" : "",
      confirm: r.needsOwner
        ? `Approve ${purchaseReturnLabel(r.no)}? It is above the owner-approval limit, so the owner approves it next before the debit note is issued.`
        : `Approve ${purchaseReturnLabel(r.no)} and issue its debit note to ${r.supplier}? The debit note moves no stock.`,
    });
  }
  if (stage === "awaiting_owner")
    out.push({ id: "ownerApprove", l: "Owner approval · issue debit note", primary: true, why: why(ctx.administrator, "Only the owner (an ERP administrator) gives the second approval"), confirm: `Give the owner's approval to ${purchaseReturnLabel(r.no)} and issue its debit note?` });
  if (stage === "awaiting_approval" || stage === "awaiting_owner")
    out.push({ id: "reject", l: "Reject", why: why(can, "Rejecting a return needs the returns power"), prompt: { title: `Reject ${purchaseReturnLabel(r.no)}`, sub: "Nothing has moved: no debit note, no stock.", submit: "Reject", fields: [{ k: "note", l: "Why", t: "area", req: true }] } });
  if (stage === "to_dispatch")
    out.push({
      id: "prepareOutward",
      l: "Prepare goods return outward",
      primary: true,
      why: stockGodowns.length ? "" : "None of this lot is in stock at any godown now",
      prompt: {
        title: `Goods return outward · ${purchaseReturnLabel(r.no)}`,
        sub: `${nf(r.qty)} ${r.unit} of ${r.item} (lot ${r.lot}) going back to ${r.supplier}. Stock does not move until the dispatch is confirmed.`,
        submit: "Save outward",
        init: { date: today(), godown: stockGodowns[0] ?? "" },
        fields: [
          { k: "godown", l: "From godown", t: "select", req: true, opts: stockGodowns },
          { k: "date", l: "Dispatch date", t: "date", req: true },
          { k: "transporter", l: "Transporter", t: "text" },
          { k: "vehicle", l: "Vehicle number", t: "text" },
          { k: "lr", l: "LR / transport details", t: "text" },
          { k: "packing", l: "Packing details", t: "text", hint: "Drums, cans, bags…" },
          { k: "note", l: "Note", t: "area" },
          { k: "file", l: "Supporting document", t: "photo" },
        ],
      },
    });
  if (r.outStatus === "draft") {
    out.push({ id: "confirmOutward", l: "Confirm dispatch (stock minus)", primary: true, why: why(can || ctx.level === "manager", "A manager or somebody who approves returns confirms the dispatch"), confirm: `Confirm ${returnOutwardLabel(r.outNo!)} left ${r.outGodown}? ${nf(r.stockQty)} ${r.unit === "Pcs" ? "Pcs" : "L"} of lot ${r.lot} comes out of stock now.` });
    out.push({ id: "cancelOutward", l: "Cancel outward", why: why(can || ctx.level === "manager", "A manager or somebody who approves returns cancels it"), prompt: { title: "Cancel the outward", sub: "It was never confirmed, so no stock moved.", submit: "Cancel outward", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
  }
  if (r.outStatus === "confirmed")
    out.push({ id: "reverseOutward", l: "Reverse the dispatch", why: why(can, "Reversing a confirmed dispatch needs the returns power"), prompt: { title: `Reverse ${returnOutwardLabel(r.outNo!)}`, sub: "The goods came back or the dispatch was recorded by mistake. The stock comes back to the lot; the outward is kept, marked cancelled.", submit: "Reverse", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
  if (stage !== "cancelled" && stage !== "rejected" && stage !== "dispatched")
    out.push({
      id: "cancel",
      l: "Cancel return",
      why: can || (own && r.status === "pending") ? "" : "Cancelling an approved return needs the returns power",
      prompt: { title: `Cancel ${purchaseReturnLabel(r.no)}`, sub: r.dnId ? `Debit note ${debitNoteLabel(r.dnNo!)} is cancelled with it, and kept.` : "Nothing has moved yet.", submit: "Cancel return", fields: [{ k: "reason", l: "Why", t: "area", req: true }] },
    });
  if (r.dnId) out.push({ id: "openDn", l: `Open ${debitNoteLabel(r.dnNo!)}`, href: erpLink("debitNotes", { open: r.dnId }) });
  return out;
}

async function vendorForm(ctx: ErpContext) {
  const lots = (await returnableLots()).filter((l) => l.returnable > 0 && l.onShelf > 0);
  const opt = (l: (typeof lots)[number]) => lotOption(l);
  const fill = (f: (l: (typeof lots)[number]) => string) => ({ by: ["lot"], map: Object.fromEntries(lots.map((l) => [opt(l), f(l)])) });
  const money = seesMoney(ctx);
  const header: FieldSpec[] = [
    { k: "lot", l: "Original GRN lot", t: "select", req: true, opts: lots.map(opt), hint: "Lots with stock still on a shelf and something left to return.", wide: true },
    { k: "vendor", l: "Vendor", t: "text", readOnly: true, fillBy: fill((l) => l.supplier) },
    { k: "grn", l: "GRN", t: "text", readOnly: true, fillBy: fill((l) => `${l.grn ?? `PR ${l.prNumber}`} · ${l.purchaseDate}`) },
    { k: "invoice", l: "Purchase invoice", t: "text", readOnly: true, fillBy: fill((l) => l.billNumber ?? "Bill not recorded") },
    { k: "material", l: "Material · batch", t: "text", readOnly: true, fillBy: fill((l) => `${l.item} · ${l.lotNo}`) },
    { k: "original", l: "Original quantity", t: "text", readOnly: true, fillBy: fill((l) => `${nf(l.quantity)} ${l.unit}`) },
    { k: "available", l: "Available to return", t: "text", readOnly: true, fillBy: fill((l) => `${nf(l.returnable)} ${l.unit} · ${nf(l.onShelf)} ${l.unit === "Pcs" ? "Pcs" : "L"} on the shelf`) },
    ...(money ? [{ k: "rate", l: "Purchase rate", t: "text" as const, readOnly: true, fillBy: fill((l) => (l.ratePaise == null ? "No rate yet" : `${inr(l.ratePaise)} / ${l.unit} + ${l.gstBp / 100}% GST`)) }] : []),
    { k: "date", l: "Return date", t: "date", req: true, sec: "The return" },
    { k: "qty", l: "Return quantity", t: "num", req: true, min: 0.001, hint: "In the lot's purchase unit (Kg, Litre or Pcs)." },
    { k: "reason", l: "Return reason", t: "select", req: true, opts: VENDOR_REASON_LABELS },
    { k: "remarks", l: "Remarks", t: "area", mic: true, wide: true },
    { k: "photo", l: "Photo / document", t: "photo" },
  ];
  return { screen: "vendorReturns", id: "new", title: "Raise a purchase return", sub: "Against the original GRN lot. Approval issues the debit note.", submit: "Raise return", header, init: { date: today() } };
}

const vendorReturns: ScreenModule = {
  key: "vendorReturns",
  async load(ctx) {
    const [rows, lots] = await Promise.all([vendorRows(), rmLots()]);
    const stockAt = (lot: string) => lots.filter((l) => l.lotNo === lot && l.stock > 0).map((l) => l.godown);
    const money = seesMoney(ctx);
    const cols: ColSpec[] = [
      { k: "no", l: "Return", t: "mono" },
      { k: "stage", l: "Stage", t: "s" },
      { k: "supplier", l: "Vendor", t: "b" },
      { k: "item", l: "Material", t: "t" },
      { k: "lot", l: "Batch", t: "mono" },
      { k: "qty", l: "Quantity", t: "n" },
      { k: "unit", l: "Unit", t: "t" },
      ...(money ? [{ k: "total", l: "Debit value", t: "m" as const }] : []),
      { k: "reason", l: "Reason", t: "t" },
      { k: "date", l: "Date", t: "d" },
      { k: "f", l: "Flags", t: "f" },
    ];
    return {
      spec: {
        screen: "vendorReturns",
        cols,
        hidden: money ? [] : [{ l: "Debit value", power: "viewPurchaseMoney" }],
        groups: ["stage", "supplier"],
        chips: "stage",
        sortDefault: ["date", -1],
        newForm: await vendorForm(ctx),
        newLabel: "Raise purchase return",
        noDataLine: "No purchase returns. Raise one against a defective or wrong GRN lot.",
      },
      rows: rows.map((r): ListRow => {
        const stage = vStage(r);
        const fields: RowField[] = [
          { l: "Vendor", v: r.supplier },
          { l: "GRN · PR", v: `PR ${r.pr}` },
          { l: "Purchase invoice", v: r.bill ?? "Bill not recorded" },
          { l: "Material · batch", v: `${r.item} · ${r.lot}` },
          { l: "Return quantity", v: `${nf(r.qty)} ${r.unit} (${nf(r.stockQty)} ${r.unit === "Pcs" ? "Pcs" : "L"} of stock)` },
          { l: "Reason", v: reasonLabel(r.reason, "vendor") },
          ...(r.remarks ? [{ l: "Remarks", v: r.remarks }] : []),
          ...(money && r.total != null ? [{ l: "Value", v: `${inr(r.amount)} + GST ${inr(r.tax)} = ${inr(r.total)}`, der: true }] : []),
          { l: "Approval", v: r.approvedAt ? `${r.approver ?? "—"} · ${stampLine(null, r.approvedAt).replace(/^Created /, "")}${r.needsOwner ? (r.ownerApprovedAt ? ` · owner ${r.ownerApprover}` : " · owner approval still needed") : ""}` : r.status === "pending" ? "Waiting" : "—" },
          { l: "Debit note", v: r.dnNo ? `${debitNoteLabel(r.dnNo)} · ${inr(r.dnTotal)} · moves no stock` : "Not issued" },
          { l: "Goods return outward", v: r.outNo ? `${returnOutwardLabel(r.outNo)} · ${r.outStatus === "confirmed" ? `confirmed, left ${r.outGodown} on ${fd(r.outDate)} — stock reduced` : `prepared at ${r.outGodown}, not confirmed — stock unchanged`}` : "Not prepared" },
          ...(r.note ? [{ l: "Decision note", v: r.note }] : []),
          ...(r.cancelReason ? [{ l: "Cancelled because", v: r.cancelReason }] : []),
        ];
        return {
          id: r.id,
          v: { no: purchaseReturnLabel(r.no), stage: VENDOR_STAGE_LABEL[stage], supplier: r.supplier, item: r.item, lot: r.lot, qty: r.qty, unit: r.unit, total: r.total, reason: reasonLabel(r.reason, "vendor"), date: r.date },
          flags: [...(r.needsOwner && !r.ownerApprovedAt && r.status === "approved" ? ["ownerApproval"] : []), ...(r.rate == null && r.status === "pending" ? ["noRate"] : [])],
          title: `${purchaseReturnLabel(r.no)} · ${r.item}`,
          header: `${r.supplier} · lot ${r.lot} · ${VENDOR_STAGE_LABEL[stage]}`,
          fields,
          actions: vendorActions(ctx, r, stockAt(r.lot)),
          by: stampLine(r.requester, r.createdAt),
          panel: { kind: "returnFlow", data: { steps: ["Purchase return", "Approval", "Debit note", "Return outward", "Confirmed · stock minus"], step: stage === "awaiting_approval" || stage === "awaiting_owner" ? 1 : stage === "to_dispatch" ? 3 : stage === "outward_drafted" ? 3 : stage === "dispatched" ? 5 : 0, stopped: stage === "cancelled" || stage === "rejected" ? VENDOR_STAGE_LABEL[stage] : null } },
        };
      }),
    };
  },
  forms: {
    async new(ctx, h) {
      const lots = await returnableLots();
      const lot = lots.find((l) => lotOption(l) === h.lot);
      if (!lot) return fieldErr("lot", "Choose the GRN lot the material came on.");
      const qty = num(h.qty);
      if (qty == null) return fieldErr("qty", "Enter the quantity to return.");
      const reason = reasonByLabel(h.reason ?? "", "vendor");
      if (!reason) return fieldErr("reason", "Choose a reason.");
      const stockQty = toStockQty(qty, lot.unit, lot.density);
      if (stockQty == null) return fieldErr("qty", "This kg lot has no density, so its stock in litres is unknown. Set the density on the register first.");
      /* On the shelf, in the PURCHASE unit, so it compares with the quantity typed. */
      const onShelfPurchase = lot.unit === "Kg" && lot.density ? r3(lot.onShelf * lot.density) : lot.onShelf;
      const refusal = vendorReturnRefusal({ qty, returnable: lot.returnable, onShelf: onShelfPurchase });
      if (refusal) return fieldErr("qty", refusal);
      const v = returnValue({ qty, ratePaise: lot.ratePaise, gstBp: lot.gstBp });
      const needsOwner = approvalSteps(v?.totalPaise ?? null, await ownerLimit()) === 2;
      const id = erpId("epr");
      const res = await inTx(async (tx) => {
        const returnNo = await nextNumber(tx, "purchaseReturn");
        await tx.insert(erpPurchaseReturns).values({
          id,
          returnNo,
          returnDate: text(h.date) ?? today(),
          purchaseId: lot.purchaseId,
          supplierId: lot.supplierId,
          rawMaterialId: lot.rawMaterialId,
          lotNo: lot.lotNo,
          prNumber: lot.prNumber,
          quantity: qty,
          unit: lot.unit,
          stockQty,
          ratePaise: lot.ratePaise,
          gstBp: lot.gstBp,
          amountPaise: v?.amountPaise ?? null,
          taxPaise: v?.taxPaise ?? null,
          totalPaise: v?.totalPaise ?? null,
          reasonCode: reason,
          remarks: text(h.remarks),
          needsOwner,
          createdById: ctx.actor.id,
        });
        await bindErpFiles(tx as unknown as typeof db, [text(h.photo)], "erp_vendor_return", id, ctx.actor.id);
        return okVoid(`${purchaseReturnLabel(returnNo)} raised — it waits for approval. Nothing has moved yet.`);
      });
      if (res.ok) await erpAudit(ctx, "erp.purchaseReturn.create", "erp_purchase_return", id, null, { lot: lot.lotNo, qty, unit: lot.unit, reason, total: v?.totalPaise ?? null, needsOwner });
      return res;
    },
  },
  actions: {
    async approve(ctx, id) {
      return decideVendor(ctx, id, 1);
    },
    async ownerApprove(ctx, id) {
      return decideVendor(ctx, id, 2);
    },
    async reject(ctx, id, v) {
      if (!approves(ctx)) return err("Rejecting a return needs the returns power.", "not_permitted");
      const note = text(v.note);
      if (!note) return fieldErr("note", "Say why");
      const [r] = await vendorRows(sql`r.id = ${id}`);
      if (!r || r.status === "cancelled" || r.status === "rejected") return err("That return is not waiting for a decision.", "conflict");
      if (r.dnId) return err("A debit note has been issued — cancel the return instead.", "conflict");
      await db.update(erpPurchaseReturns).set({ status: "rejected", decisionNote: note, approvedById: ctx.actor.id, approvedAt: new Date(), updatedAt: new Date() }).where(eq(erpPurchaseReturns.id, id));
      await erpAudit(ctx, "erp.purchaseReturn.reject", "erp_purchase_return", id, { status: r.status }, { status: "rejected", note });
      return okVoid(`${purchaseReturnLabel(r.no)} rejected`);
    },
    async prepareOutward(ctx, id, v) {
      const godownId = await godownIdByName(text(v.godown));
      if (!godownId) return fieldErr("godown", "Choose the godown the goods leave from.");
      const date = text(v.date);
      if (!date) return fieldErr("date", "Enter the dispatch date.");
      const outId = erpId("ero");
      const res = await inTx(async (tx) => {
        const [r] = await vendorRows(sql`r.id = ${id}`, tx);
        if (!r || vStage(r) !== "to_dispatch") return err("This return is not ready for its goods to go: it needs approval and a debit note first.", "conflict");
        const outwardNo = await nextNumber(tx, "returnOutward");
        try {
          await tx.insert(erpReturnOutwards).values({
            id: outId,
            outwardNo,
            purchaseReturnId: r.id,
            supplierId: r.supplierId,
            rawMaterialId: r.rm,
            lotNo: r.lot,
            godownId,
            quantity: r.qty,
            unit: r.unit,
            stockQty: r.stockQty,
            packing: text(v.packing),
            transporter: text(v.transporter),
            vehicleNo: text(v.vehicle),
            lrNo: text(v.lr),
            dispatchDate: date,
            note: text(v.note),
            createdById: ctx.actor.id,
          });
        } catch {
          return refuse(err("An outward for this return already exists.", "conflict"));
        }
        await bindErpFiles(tx as unknown as typeof db, [text(v.file)], "erp_vendor_return", outId, ctx.actor.id);
        return okVoid(`${returnOutwardLabel(outwardNo)} prepared. Stock moves when the dispatch is confirmed.`);
      });
      if (res.ok) await erpAudit(ctx, "erp.returnOutward.create", "erp_return_outward", outId, null, { return: id, godownId, date });
      return res;
    },
    async confirmOutward(ctx, id) {
      if (!approves(ctx) && ctx.level !== "manager") return err("A manager or somebody who approves returns confirms the dispatch.", "not_permitted");
      let label = "";
      const res = await inTx(async (tx) => {
        const [o] = await tx.select().from(erpReturnOutwards).where(and(eq(erpReturnOutwards.purchaseReturnId, id), eq(erpReturnOutwards.status, "draft"))).for("update");
        if (!o) return err("There is no unconfirmed outward on this return.", "conflict");
        /* Both spellings the ERP locks raw-material lots under, then the stock read again under the locks. */
        await lockLot(tx, "rm", o.lotNo, o.godownId);
        await lockLot(tx, "Purchase", o.lotNo, o.godownId);
        const have = (await rmLots(tx)).find((l) => l.lotNo === o.lotNo && l.godownId === o.godownId)?.stock ?? 0;
        if (have + 1e-9 < Number(o.stockQty)) return err(`Only ${nf(have)} of lot ${o.lotNo} is at that godown now — the outward needs ${nf(Number(o.stockQty))}. Stock never goes negative.`, "rule_violation");
        await tx.update(erpReturnOutwards).set({ status: "confirmed", confirmedById: ctx.actor.id, confirmedAt: new Date() }).where(eq(erpReturnOutwards.id, o.id));
        label = returnOutwardLabel(o.outwardNo);
        return okVoid(`${label} confirmed — ${nf(Number(o.stockQty))} ${o.unit === "Pcs" ? "Pcs" : "L"} of lot ${o.lotNo} is out of stock`);
      });
      if (res.ok) await erpAudit(ctx, "erp.returnOutward.confirm", "erp_purchase_return", id, { status: "draft" }, { status: "confirmed", outward: label });
      return res;
    },
    async cancelOutward(ctx, id, v) {
      if (!approves(ctx) && ctx.level !== "manager") return err("A manager or somebody who approves returns cancels it.", "not_permitted");
      const reason = text(v.reason);
      if (!reason) return fieldErr("reason", "Say why");
      const done = await db
        .update(erpReturnOutwards)
        .set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: new Date() })
        .where(and(eq(erpReturnOutwards.purchaseReturnId, id), eq(erpReturnOutwards.status, "draft")))
        .returning({ id: erpReturnOutwards.id });
      if (!done.length) return err("There is no unconfirmed outward on this return.", "conflict");
      await erpAudit(ctx, "erp.returnOutward.cancel", "erp_return_outward", done[0].id, { status: "draft" }, { status: "cancelled", reason });
      return okVoid("Outward cancelled — nothing had moved");
    },
    async reverseOutward(ctx, id, v) {
      if (!approves(ctx)) return err("Reversing a confirmed dispatch needs the returns power.", "not_permitted");
      const reason = text(v.reason);
      if (!reason || reason.length < 10) return fieldErr("reason", "Say why (10 characters or more)");
      const done = await db
        .update(erpReturnOutwards)
        .set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: new Date() })
        .where(and(eq(erpReturnOutwards.purchaseReturnId, id), eq(erpReturnOutwards.status, "confirmed")))
        .returning({ id: erpReturnOutwards.id, lot: erpReturnOutwards.lotNo, qty: erpReturnOutwards.stockQty });
      if (!done.length) return err("There is no confirmed outward on this return.", "conflict");
      await erpAudit(ctx, "erp.returnOutward.reverse", "erp_return_outward", done[0].id, { status: "confirmed" }, { status: "cancelled", reason });
      return okVoid(`Dispatch reversed — ${nf(Number(done[0].qty))} of lot ${done[0].lot} is back in stock`);
    },
    async cancel(ctx, id, v) {
      const reason = text(v.reason);
      if (!reason) return fieldErr("reason", "Say why");
      let before = "";
      const res = await inTx(async (tx) => {
        const [r] = await vendorRows(sql`r.id = ${id}`, tx);
        if (!r) return err("That return is gone.", "not_found");
        const own = r.requesterId === ctx.user.id && r.status === "pending";
        if (!approves(ctx) && !own) return err("Cancelling an approved return needs the returns power.", "not_permitted");
        if (r.status === "cancelled" || r.status === "rejected") return err("That return is already closed.", "conflict");
        if (r.outStatus === "confirmed") return err("Its goods have left — reverse the dispatch first, then cancel the return.", "conflict");
        before = r.status;
        const now = new Date();
        await tx.update(erpPurchaseReturns).set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: now, updatedAt: now }).where(eq(erpPurchaseReturns.id, id));
        await tx.update(erpDebitNotes).set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: now }).where(and(eq(erpDebitNotes.purchaseReturnId, id), eq(erpDebitNotes.status, "issued")));
        await tx.update(erpReturnOutwards).set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: now }).where(and(eq(erpReturnOutwards.purchaseReturnId, id), eq(erpReturnOutwards.status, "draft")));
        return okVoid(`${purchaseReturnLabel(r.no)} cancelled${r.dnNo ? ` with ${debitNoteLabel(r.dnNo)}` : ""} — both are kept, marked cancelled`);
      });
      if (res.ok) await erpAudit(ctx, "erp.purchaseReturn.cancel", "erp_purchase_return", id, { status: before }, { status: "cancelled", reason });
      return res;
    },
  },
};

/** The first approval, or the owner's. The last one needed issues the debit note in the same transaction. */
async function decideVendor(ctx: ErpContext, id: string, step: 1 | 2): Promise<Result<unknown>> {
  let noteNo: number | null = null;
  const res = await inTx(async (tx) => {
    const [r] = await vendorRows(sql`r.id = ${id}`, tx);
    if (!r) return err("That return is gone.", "not_found");
    const stage = vStage(r);
    if (step === 1 && stage !== "awaiting_approval") return err("This return is not waiting for its first approval.", "conflict");
    if (step === 2 && stage !== "awaiting_owner") return err("This return is not waiting for the owner.", "conflict");
    const refusal = approvalRefusal({ step, actorId: ctx.actor.id, requesterId: r.requesterId, firstApproverId: r.approvedById, administrator: ctx.administrator, hasPower: ctx.powers.has("returnApprove") });
    if (refusal) return err(refusal, "not_permitted");
    const now = new Date();
    /* The limit is read again: the value may have been unknown when it was raised. */
    const [lot] = (await tx.execute(sql`select rate_paise::float8 as rate, gst_bp as "gstBp" from erp_purchases where id = ${r.purchaseId}`)) as unknown as { rate: number | null; gstBp: number }[];
    const v = returnValue({ qty: r.qty, ratePaise: lot?.rate == null ? null : Number(lot.rate), gstBp: Number(lot?.gstBp ?? r.gstBp) });
    const needsOwner = approvalSteps(v?.totalPaise ?? null, await ownerLimit()) === 2;
    if (step === 1) {
      await tx.update(erpPurchaseReturns).set({ status: "approved", approvedById: ctx.actor.id, approvedAt: now, needsOwner, updatedAt: now }).where(eq(erpPurchaseReturns.id, id));
      if (needsOwner) return okVoid(`${purchaseReturnLabel(r.no)} approved — above the owner-approval limit, so the owner approves it next`);
    } else {
      await tx.update(erpPurchaseReturns).set({ ownerApprovedById: ctx.actor.id, ownerApprovedAt: now, updatedAt: now }).where(eq(erpPurchaseReturns.id, id));
    }
    noteNo = await issueDebitNote(tx, ctx, r);
    return okVoid(`${purchaseReturnLabel(r.no)} approved and ${debitNoteLabel(noteNo)} issued to ${r.supplier}. No stock has moved — prepare the goods return outward next.`);
  });
  if (res.ok) await erpAudit(ctx, step === 1 ? "erp.purchaseReturn.approve" : "erp.purchaseReturn.ownerApprove", "erp_purchase_return", id, null, { step, debitNote: noteNo == null ? null : debitNoteLabel(noteNo) });
  return res;
}

/* ------------------------------------------------------------ debit notes */

const debitNotes: ScreenModule = {
  key: "debitNotes",
  async load(ctx) {
    const rows = (await db.execute(sql`
      select dn.id, dn.note_no as no, dn.note_date::text as date, dn.status, s.name as supplier, dn.bill_number as bill, dn.pr_number as pr,
             r.id as "returnId", r.return_no as "returnNo", m.name as item, dn.lot_no as lot, dn.quantity::float8 as qty, dn.unit,
             dn.rate_paise::float8 as rate, dn.gst_bp as "gstBp", dn.amount_paise::float8 as amount, dn.tax_paise::float8 as tax,
             dn.total_paise::float8 as total, dn.reason_code as reason, u.name as "by", dn.created_at as "createdAt", dn.cancel_reason as "cancelReason"
        from erp_debit_notes dn
        join erp_suppliers s on s.id = dn.supplier_id
        join erp_purchase_returns r on r.id = dn.purchase_return_id
        join erp_raw_materials m on m.id = dn.raw_material_id
        left join users u on u.id = dn.created_by_id
       order by dn.created_at desc
    `)) as unknown as Row[];
    const money = seesMoney(ctx);
    return {
      spec: {
        screen: "debitNotes",
        cols: [
          { k: "no", l: "Debit note", t: "mono" },
          { k: "status", l: "Status", t: "s" },
          { k: "date", l: "Date", t: "d" },
          { k: "supplier", l: "Vendor", t: "b" },
          { k: "item", l: "Material", t: "t" },
          { k: "lot", l: "Batch", t: "mono" },
          { k: "qty", l: "Quantity", t: "n" },
          ...(money ? [{ k: "total", l: "Total", t: "m" as const }] : []),
          { k: "ret", l: "Return", t: "mono" },
        ],
        hidden: money ? [] : [{ l: "Amounts", power: "viewPurchaseMoney" }],
        groups: ["supplier", "status"],
        chips: "status",
        readOnly: true,
        sortDefault: ["date", -1],
        noDataLine: "No debit notes. One is issued when a purchase return is approved.",
      },
      rows: rows.map((r): ListRow => ({
        id: String(r.id),
        v: { no: debitNoteLabel(Number(r.no)), status: r.status === "issued" ? "Issued" : "Cancelled", date: String(r.date), supplier: String(r.supplier), item: String(r.item), lot: String(r.lot), qty: Number(r.qty), total: Number(r.total), ret: purchaseReturnLabel(Number(r.returnNo)) },
        flags: [],
        title: `${debitNoteLabel(Number(r.no))} · ${r.supplier}`,
        header: `${fd(String(r.date))} · against ${purchaseReturnLabel(Number(r.returnNo))} · a financial adjustment: no stock moves`,
        fields: [
          { l: "Vendor", v: String(r.supplier) },
          { l: "Original GRN · PR", v: `PR ${r.pr}` },
          { l: "Original purchase invoice", v: r.bill ? String(r.bill) : "Bill not recorded" },
          { l: "Purchase return", v: purchaseReturnLabel(Number(r.returnNo)) },
          { l: "Material · batch", v: `${r.item} · ${r.lot}` },
          { l: "Quantity", v: `${nf(Number(r.qty))} ${r.unit}` },
          ...(money
            ? [
                { l: "Rate", v: `${inr(Number(r.rate))} / ${r.unit}` },
                { l: "Tax", v: `${Number(r.gstBp) / 100}% · ${inr(Number(r.tax))}` },
                { l: "Total debit amount", v: `${inr(Number(r.amount))} + ${inr(Number(r.tax))} = ${inr(Number(r.total))}`, der: true },
              ]
            : []),
          { l: "Return reason", v: reasonLabel(String(r.reason), "vendor") },
          { l: "Payables", v: r.status === "issued" ? "Reduces the vendor's unpaid purchase payout on Accounts → Cash flow → Payables." : "Cancelled — no longer reduces the payout." },
          ...(r.cancelReason ? [{ l: "Cancelled because", v: String(r.cancelReason) }] : []),
        ],
        actions: [{ id: "openReturn", l: `Open ${purchaseReturnLabel(Number(r.returnNo))}`, href: erpLink("vendorReturns", { open: String(r.returnId) }) }],
        by: stampLine(r.by as string | null, r.createdAt as Date),
      })),
    };
  },
};

/* --------------------------------------------------------- return outwards */

const returnOutwards: ScreenModule = {
  key: "returnOutwards",
  async load(ctx) {
    const rows = (await db.execute(sql`
      select o.id, o.outward_no as no, o.status, o.purchase_return_id as "returnId", r.return_no as "returnNo", s.name as supplier, m.name as item,
             o.lot_no as lot, g.name as godown, o.quantity::float8 as qty, o.unit, o.stock_qty::float8 as "stockQty", o.packing, o.transporter,
             o.vehicle_no as vehicle, o.lr_no as lr, o.dispatch_date::text as date, o.note, o.cancel_reason as "cancelReason",
             uc.name as confirmer, o.confirmed_at as "confirmedAt", u.name as "by", o.created_at as "createdAt"
        from erp_return_outwards o
        join erp_purchase_returns r on r.id = o.purchase_return_id
        join erp_suppliers s on s.id = o.supplier_id
        join erp_raw_materials m on m.id = o.raw_material_id
        join erp_godowns g on g.id = o.godown_id
        left join users uc on uc.id = o.confirmed_by_id
        left join users u on u.id = o.created_by_id
       order by o.created_at desc
    `)) as unknown as Row[];
    const word = (s: string) => (s === "confirmed" ? "Confirmed" : s === "draft" ? "Draft" : "Cancelled");
    return {
      spec: {
        screen: "returnOutwards",
        cols: [
          { k: "no", l: "Outward", t: "mono" },
          { k: "status", l: "Status", t: "s" },
          { k: "date", l: "Dispatch", t: "d" },
          { k: "supplier", l: "Vendor", t: "b" },
          { k: "item", l: "Material", t: "t" },
          { k: "lot", l: "Batch", t: "mono" },
          { k: "qty", l: "Quantity", t: "n" },
          { k: "godown", l: "From", t: "t" },
          { k: "transporter", l: "Transporter", t: "t" },
        ],
        hidden: [],
        groups: ["status", "supplier"],
        chips: "status",
        godownKey: "godown",
        sortDefault: ["date", -1],
        noDataLine: "No return outwards. Stock leaves only when one is confirmed.",
      },
      rows: rows.map((r): ListRow => {
        const status = String(r.status);
        const can = approves(ctx) || ctx.level === "manager";
        const actions: ActionSpec[] = [];
        if (status === "draft") {
          actions.push({ id: "confirm", l: "Confirm dispatch (stock minus)", primary: true, why: why(can, "A manager or somebody who approves returns confirms the dispatch"), confirm: `Confirm ${returnOutwardLabel(Number(r.no))} left ${r.godown}? ${nf(Number(r.stockQty))} of lot ${r.lot} comes out of stock now.` });
          actions.push({ id: "cancel", l: "Cancel outward", why: why(can, "A manager or somebody who approves returns cancels it"), prompt: { title: "Cancel the outward", submit: "Cancel outward", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
        }
        if (status === "confirmed")
          actions.push({ id: "reverse", l: "Reverse the dispatch", why: why(approves(ctx), "Reversing a confirmed dispatch needs the returns power"), prompt: { title: "Reverse the dispatch", sub: "The stock comes back to the lot; the outward is kept, marked cancelled.", submit: "Reverse", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
        actions.push({ id: "openReturn", l: `Open ${purchaseReturnLabel(Number(r.returnNo))}`, href: erpLink("vendorReturns", { open: String(r.returnId) }) });
        return {
          id: String(r.returnId),
          v: { no: returnOutwardLabel(Number(r.no)), status: word(status), date: String(r.date), supplier: String(r.supplier), item: String(r.item), lot: String(r.lot), qty: Number(r.qty), godown: String(r.godown), transporter: (r.transporter as string | null) ?? "" },
          flags: [],
          title: `${returnOutwardLabel(Number(r.no))} · ${r.supplier}`,
          header: `${r.item} · lot ${r.lot} · ${status === "confirmed" ? "stock reduced" : status === "draft" ? "stock not yet reduced" : "cancelled"}`,
          fields: [
            { l: "Vendor", v: String(r.supplier) },
            { l: "Purchase return", v: purchaseReturnLabel(Number(r.returnNo)) },
            { l: "Material · batch", v: `${r.item} · ${r.lot}` },
            { l: "Quantity", v: `${nf(Number(r.qty))} ${r.unit}` },
            { l: "From godown", v: String(r.godown) },
            ...(r.packing ? [{ l: "Packing", v: String(r.packing) }] : []),
            { l: "Transporter · vehicle", v: [r.transporter, r.vehicle].filter(Boolean).join(" · ") || "—" },
            ...(r.lr ? [{ l: "LR / transport details", v: String(r.lr) }] : []),
            { l: "Dispatch date", v: fd(String(r.date)) },
            ...(r.confirmedAt ? [{ l: "Confirmed", v: `${r.confirmer ?? "—"} · ${stampLine(null, r.confirmedAt as Date).replace(/^Created /, "")}` }] : []),
            ...(r.note ? [{ l: "Note", v: String(r.note) }] : []),
            ...(r.cancelReason ? [{ l: "Cancelled because", v: String(r.cancelReason) }] : []),
          ],
          actions,
          by: stampLine(r.by as string | null, r.createdAt as Date),
        };
      }),
    };
  },
  actions: {
    confirm: (ctx, id, v) => vendorReturns.actions!.confirmOutward(ctx, id, v),
    cancel: (ctx, id, v) => vendorReturns.actions!.cancelOutward(ctx, id, v),
    reverse: (ctx, id, v) => vendorReturns.actions!.reverseOutward(ctx, id, v),
  },
};

/* ====================================================================
 * CUSTOMER RETURNS
 * ================================================================== */

type CustomerRow = {
  id: string;
  no: number;
  date: string;
  status: string;
  customerId: string;
  customer: string;
  orderId: string;
  orderNo: number;
  billNo: string | null;
  batchCodeId: string | null;
  skuId: string;
  sku: string;
  fgId: string | null;
  fg: string | null;
  formulationId: string | null;
  lotFrom: "fg" | "pack";
  lot: string;
  qty: number;
  unit: string;
  litres: number;
  cansPerBox: number;
  millilitres: number;
  total: number | null;
  reason: string;
  remarks: string | null;
  transporter: string | null;
  vehicle: string | null;
  lr: string | null;
  received: number | null;
  receivedGodownId: string | null;
  receivedGodown: string | null;
  receiver: string | null;
  receivedAt: Date | null;
  needsOwner: boolean;
  approvedAt: Date | null;
  approver: string | null;
  ownerApprovedAt: Date | null;
  complaintId: string | null;
  cnStatus: string | null;
  cnAmount: number | null;
  cnReference: string | null;
  cancelReason: string | null;
  note: string | null;
  requesterId: string | null;
  requester: string | null;
  createdAt: Date;
};

type DecisionRow = { id: string; returnId: string; kind: Disposition; qty: number; litres: number; godown: string | null; scrapKg: number | null; status: string; note: string | null; by: string | null; at: Date; reworkNo: number | null; reworkStatus: string | null; wasteNo: number | null; wasteStatus: string | null };

async function customerRows(where = sql`true`, ex: Tx | typeof db = db): Promise<CustomerRow[]> {
  const rows = (await ex.execute(sql`
    select r.id, r.return_no as no, r.return_date::text as date, r.status, r.customer_id as "customerId", c.name as customer,
           r.order_id as "orderId", o.order_no as "orderNo", o.tally_bill_no as "billNo", r.batch_code_id as "batchCodeId",
           r.sku_id as "skuId", p.name as sku, r.finished_good_id as "fgId", fg.name as fg, fg.formulation_id as "formulationId",
           r.lot_from as "lotFrom", r.lot_code as lot, r.quantity::float8 as qty, r.unit, r.litres::float8 as litres,
           coalesce(p.cans_per_box, 1) as "cansPerBox", coalesce(fg.millilitres, 0) as millilitres,
           r.total_paise::float8 as total, r.reason_code as reason, r.customer_remarks as remarks, r.transporter, r.vehicle_no as vehicle, r.lr_no as lr,
           r.received_qty::float8 as received, r.received_godown_id as "receivedGodownId", rg.name as "receivedGodown", ur.name as receiver,
           r.received_at as "receivedAt", r.needs_owner as "needsOwner", r.approved_at as "approvedAt", ua.name as approver,
           r.owner_approved_at as "ownerApprovedAt", r.complaint_id as "complaintId", cm.cn_status as "cnStatus",
           cm.cn_amount::float8 as "cnAmount", cm.cn_reference as "cnReference", r.cancel_reason as "cancelReason", r.decision_note as note,
           r.created_by_id as "requesterId", uc.name as requester, r.created_at as "createdAt"
      from erp_customer_returns r
      join customers c on c.id = r.customer_id
      join erp_orders o on o.id = r.order_id
      join products p on p.id = r.sku_id
      left join finished_goods fg on fg.id = r.finished_good_id
      left join erp_godowns rg on rg.id = r.received_godown_id
      left join users ur on ur.id = r.received_by_id
      left join users ua on ua.id = r.approved_by_id
      left join users uc on uc.id = r.created_by_id
      left join complaints cm on cm.id = r.complaint_id
     where ${where}
     order by r.created_at desc
  `)) as unknown as CustomerRow[];
  return rows.map((r) => ({ ...r, no: Number(r.no), orderNo: Number(r.orderNo), cansPerBox: Number(r.cansPerBox) || 1, millilitres: Number(r.millilitres) || 0 }));
}

async function decisionRows(where = sql`true`, ex: Tx | typeof db = db): Promise<DecisionRow[]> {
  return (await ex.execute(sql`
    select d.id, d.customer_return_id as "returnId", d.kind, d.quantity::float8 as qty, d.litres::float8 as litres, g.name as godown,
           d.scrap_kg::float8 as "scrapKg", d.status, d.note, u.name as by, d.decided_at as at,
           w.rework_no as "reworkNo", w.status as "reworkStatus", x.waste_no as "wasteNo", x.status as "wasteStatus"
      from erp_return_dispositions d
      left join erp_godowns g on g.id = d.godown_id
      left join users u on u.id = d.decided_by_id
      left join erp_rework_orders w on w.disposition_id = d.id
      left join erp_waste_disposals x on x.disposition_id = d.id
     where ${where}
     order by d.decided_at
  `)) as unknown as DecisionRow[];
}

const cStage = (r: CustomerRow, ds: DecisionRow[]) =>
  customerReturnStage({ status: r.status, received: r.received, disposed: ds.filter((d) => d.status === "active").reduce((a, d) => a + d.qty, 0) });

const decisionLine = (d: DecisionRow, unit: string) =>
  `${dispositionLabel(d.kind)} · ${nf(d.qty)} ${unit}${d.godown ? ` · ${d.godown}` : ""}${d.scrapKg ? ` · ${nf(d.scrapKg)} kg` : ""}${d.reworkNo ? ` · ${reworkLabel(d.reworkNo)}` : ""}${d.wasteNo ? ` · ${wasteLabel(d.wasteNo)}` : ""} · ${fd(d.at.toISOString?.() ?? String(d.at))}${d.status === "reversed" ? " · reversed" : ""}`;

const unallocatedDays = async () => Number((await getConfig())["erp.returns.unallocatedDays"] ?? 180);

async function customerForm() {
  const lines = (await returnableLines(undefined, { unallocatedDays: await unallocatedDays() })).filter((l) => l.sent - l.returned > 0);
  const noLot = lines.filter((l) => l.lotCode == null).map((l) => lineOption(l));
  const opt = (l: (typeof lines)[number]) => lineOption(l);
  const fill = (f: (l: (typeof lines)[number]) => string) => ({ by: ["line"], map: Object.fromEntries(lines.map((l) => [opt(l), f(l)])) });
  const unitOf = (l: (typeof lines)[number]) => (l.lotFrom === "pack" ? "boxes" : "cans");
  return {
    screen: "customerReturns",
    id: "new",
    title: "Record a customer return",
    sub: "Against the dispatched order line. Received material goes into quarantine.",
    submit: "Record return",
    init: { date: today() },
    header: [
      {
        k: "line",
        l: "Original order line and lot",
        t: "select",
        req: true,
        typed: "Type the order number, customer or product",
        opts: lines.map(opt),
        hint: "Lines that went out with something not already returned — with their lot, or with no lot allocated (older and sheet orders).",
        wide: true,
      },
      { k: "customer", l: "Customer", t: "text", readOnly: true, fillBy: fill((l) => l.customer) },
      { k: "invoice", l: "Sales invoice", t: "text", readOnly: true, fillBy: fill((l) => l.billNo ?? `${orderTraceCode(l.orderNo)} (no Tally bill number)`) },
      { k: "outward", l: "Goods outward", t: "text", readOnly: true, fillBy: fill((l) => (l.dispatchDate ? `Dispatched ${fd(l.dispatchDate)} from ${l.godown}` : `From ${l.godown} · dispatch not recorded`)) },
      { k: "product", l: "Product · batch", t: "text", readOnly: true, fillBy: fill((l) => `${l.sku} · ${l.lotCode ?? "no lot allocated"}`) },
      ...(noLot.length
        ? [
            {
              k: "batch",
              l: "Batch on the returned cans",
              t: "text" as const,
              hint: "No lot was allocated on this line, so read the batch off the label of the cans that came back.",
              when: { k: "line", in: noLot },
              reqWhen: { k: "line", in: noLot },
            },
          ]
        : []),
      { k: "sent", l: "Sent · already returned", t: "text", readOnly: true, fillBy: fill((l) => `${nf(l.sent)} ${unitOf(l)} · ${nf(l.returned)} returned`) },
      { k: "date", l: "Return date", t: "date", req: true, sec: "The return" },
      { k: "qty", l: "Return quantity", t: "num", req: true, min: 1, hint: "Whole cans, or whole boxes on a boxed line." },
      { k: "reason", l: "Return reason", t: "select", req: true, opts: CUSTOMER_REASON_LABELS },
      { k: "remarks", l: "Customer remarks", t: "area", mic: true, wide: true },
      { k: "transporter", l: "Transporter", t: "text", sec: "Transport" },
      { k: "vehicle", l: "Vehicle number", t: "text" },
      { k: "lr", l: "LR / transport details", t: "text" },
      { k: "photo", l: "Photo / document", t: "photo" },
    ] as FieldSpec[],
  };
}

function customerActions(ctx: ErpContext, r: CustomerRow, ds: DecisionRow[], godowns: string[]): ActionSpec[] {
  const stage = cStage(r, ds);
  const left = quarantineLeft(r.received, ds);
  const can = approves(ctx);
  const own = r.requesterId === ctx.user.id && !ctx.administrator;
  const unit = r.unit.toLowerCase();
  const out: ActionSpec[] = [];
  if (stage === "awaiting_receipt") {
    out.push({
      id: "receive",
      l: "Receive into quarantine",
      primary: true,
      prompt: {
        title: `Return inward · ${customerReturnLabel(r.no)}`,
        sub: "Received into Customer Return / Quarantine. It stays out of saleable stock until QC decides.",
        submit: "Receive",
        init: { qty: String(r.qty), godown: ctx.workingGodown?.name ?? godowns[0] ?? "" },
        fields: [
          { k: "qty", l: `Received (${unit})`, t: "num", req: true, min: 1, max: r.qty },
          { k: "godown", l: "Held at godown", t: "select", req: true, opts: godowns },
          { k: "note", l: "Note", t: "area" },
        ],
      },
    });
    out.push({ id: "reject", l: "Reject the return", why: why(can, "Rejecting a return needs the returns power"), prompt: { title: `Reject ${customerReturnLabel(r.no)}`, sub: "The material is not accepted back. Nothing has moved.", submit: "Reject", fields: [{ k: "note", l: "Why", t: "area", req: true }] } });
  }
  if (r.received != null && r.status === "open" && !r.complaintId) {
    if (!r.approvedAt)
      out.push({
        id: "approveCredit",
        l: r.needsOwner ? "Approve credit note (the owner approves next)" : "Approve and raise credit note",
        why: r.total == null ? "The order line has no rate, so no credit note can be valued" : !can ? "Approving a return needs the returns power" : own ? "Somebody other than whoever recorded it approves it" : "",
        confirm: `Raise the credit note for ${customerReturnLabel(r.no)} (${inr(r.total)}) to Accounts? It moves no stock — the material stays in quarantine until QC decides.`,
      });
    else if (r.needsOwner && !r.ownerApprovedAt)
      out.push({ id: "ownerApproveCredit", l: "Owner approval · raise credit note", primary: true, why: why(ctx.administrator, "Only the owner (an ERP administrator) gives the second approval"), confirm: `Give the owner's approval and raise the credit note for ${customerReturnLabel(r.no)}?` });
  }
  if (r.complaintId) out.push({ id: "openCredit", l: r.cnStatus === "issued" ? "Open the issued credit note" : "Issue the credit note (Accounts)", href: erpLink("issueCn", { open: r.complaintId }) });
  if (left > 0 && r.status === "open")
    out.push({
      id: "decide",
      l: "QC decision",
      primary: stage !== "awaiting_receipt",
      why: why(decidesQc(ctx), "QC decisions on returned material need the returns QC power"),
      prompt: {
        title: `QC decision · ${customerReturnLabel(r.no)}`,
        sub: `${nf(left)} ${unit} still in quarantine. Reusable goes back into the existing FG stock (same item, same lot); rework goes through the existing SFG process; unusable goes to Chemical Scrap or waste.`,
        submit: "Record decision",
        init: { qty: String(left), godown: r.receivedGodown ?? godowns[0] ?? "" },
        fields: [
          { k: "kind", l: "Decision", t: "select", req: true, opts: DISPOSITIONS.map((d) => d.label) },
          { k: "qty", l: `Quantity (${unit})`, t: "num", req: true, min: 1, max: left },
          { k: "godown", l: "To godown", t: "select", opts: godowns, when: { k: "kind", in: ["Reusable as is", "Rework", "Chemical scrap"] }, reqWhen: { k: "kind", in: ["Reusable as is", "Rework", "Chemical scrap"] } },
          { k: "scrapKg", l: "Chemical scrap weight (kg)", t: "num", min: 0.001, when: { k: "kind", eq: "Chemical scrap" }, reqWhen: { k: "kind", eq: "Chemical scrap" } },
          { k: "wasteReason", l: "Why it cannot be reused or sold as scrap", t: "area", when: { k: "kind", eq: "Waste disposal" }, reqWhen: { k: "kind", eq: "Waste disposal" } },
          { k: "note", l: "QC note", t: "area" },
        ],
      },
    });
  const reversible = ds.filter((d) => d.status === "active" && (d.kind === "reuse" || d.kind === "scrap" || (d.kind === "rework" && d.reworkStatus === "open") || (d.kind === "waste" && d.wasteStatus === "pending")));
  if (reversible.length)
    out.push({
      id: "reverseDecision",
      l: "Reverse a QC decision",
      why: why(decidesQc(ctx), "Reversing a QC decision needs the returns QC power"),
      prompt: {
        title: "Reverse a QC decision",
        sub: "The material goes back into quarantine. The decision is kept, marked reversed. A rework already completed or a waste already disposed of cannot be reversed.",
        submit: "Reverse",
        fields: [
          { k: "decision", l: "Decision", t: "select", req: true, opts: reversible.map((d) => decisionLine(d, unit)) },
          { k: "reason", l: "Why", t: "area", req: true },
        ],
      },
    });
  if (r.status === "open" && !ds.some((d) => d.status === "active") && r.cnStatus !== "issued")
    out.push({ id: "cancel", l: "Cancel return", why: can || (own && r.received == null) ? "" : "Cancelling a received return needs the returns power", prompt: { title: `Cancel ${customerReturnLabel(r.no)}`, sub: r.complaintId ? "Its credit-note request is refused with it." : "", submit: "Cancel return", fields: [{ k: "reason", l: "Why", t: "area", req: true }] } });
  return out;
}

function customerRowFor(ctx: ErpContext, r: CustomerRow, ds: DecisionRow[], godowns: string[]): ListRow {
  const stage = cStage(r, ds);
  const left = quarantineLeft(r.received, ds);
  const unit = r.unit.toLowerCase();
  return {
    id: r.id,
    v: {
      no: customerReturnLabel(r.no),
      stage: CUSTOMER_STAGE_LABEL[stage],
      customer: r.customer,
      sku: r.sku,
      lot: r.lot,
      qty: r.qty,
      unit: r.unit,
      quarantine: left,
      credit: creditNoteWord(r.cnStatus, !!r.complaintId),
      total: r.total,
      date: r.date,
    },
    flags: [...(left > 0 ? ["quarantine"] : []), ...(r.needsOwner && r.approvedAt && !r.ownerApprovedAt ? ["ownerApproval"] : []), ...(r.complaintId && r.cnStatus !== "issued" ? ["creditRaised"] : [])],
    title: `${customerReturnLabel(r.no)} · ${r.customer}`,
    header: `${r.sku} · lot ${r.lot} · ${CUSTOMER_STAGE_LABEL[stage]}`,
    fields: [
      { l: "Customer", v: r.customer },
      { l: "Original sales invoice", v: r.billNo ?? "No Tally bill number" },
      { l: "Original goods outward", v: orderTraceCode(r.orderNo) },
      { l: "Product · batch", v: `${r.sku} · ${r.lot}` },
      { l: "Return quantity", v: `${nf(r.qty)} ${unit} · ${nf(r.litres)} L` },
      { l: "Reason", v: reasonLabel(r.reason, "customer") },
      ...(r.remarks ? [{ l: "Customer remarks", v: r.remarks }] : []),
      ...(r.transporter || r.vehicle || r.lr ? [{ l: "Transport", v: [r.transporter, r.vehicle, r.lr].filter(Boolean).join(" · ") }] : []),
      { l: "Return inward", v: r.receivedAt ? `${nf(r.received ?? 0)} ${unit} at ${r.receivedGodown} · ${r.receiver ?? "—"} · ${stampLine(null, r.receivedAt).replace(/^Created /, "")}` : "Not received yet" },
      { l: "In quarantine", v: `${nf(left)} ${unit} — not saleable stock` },
      { l: "Credit note", v: r.complaintId ? `${creditNoteWord(r.cnStatus, true)}${r.cnStatus === "issued" ? ` · ${inr(r.cnAmount)}${r.cnReference ? ` · ${r.cnReference}` : ""}` : ` · ${inr(r.total)} asked`} · moves no stock` : r.total == null ? "No rate on the order line — cannot be valued" : `Not raised · ${inr(r.total)}` },
      ...ds.map((d, i) => ({ l: i === 0 ? "QC decisions" : "", v: decisionLine(d, unit) })),
      ...(r.note ? [{ l: "Note", v: r.note }] : []),
      ...(r.cancelReason ? [{ l: "Cancelled because", v: r.cancelReason }] : []),
    ],
    actions: customerActions(ctx, r, ds, godowns),
    by: stampLine(r.requester, r.createdAt),
    panel: { kind: "returnFlow", data: { steps: ["Customer return", "Return inward", "Quarantine", "Credit note", "QC decision", "Closed"], step: stage === "awaiting_receipt" ? 1 : stage === "in_quarantine" ? (r.complaintId ? 4 : 3) : stage === "partly_disposed" ? 5 : stage === "closed" ? 6 : 0, stopped: stage === "cancelled" || stage === "rejected" ? CUSTOMER_STAGE_LABEL[stage] : null } },
  };
}

async function customerScreen(ctx: ErpContext, key: "customerReturns" | "returnQc") {
  const [rows, ds, gds] = await Promise.all([customerRows(), decisionRows(), godownOptions(ctx, { lost: false })]);
  const godowns = gds.map((g) => g.name);
  const byReturn = new Map<string, DecisionRow[]>();
  for (const d of ds) byReturn.set(d.returnId, [...(byReturn.get(d.returnId) ?? []), d]);
  const list = rows
    .map((r) => ({ r, d: byReturn.get(r.id) ?? [] }))
    .filter(({ r, d }) => key === "customerReturns" || (r.status === "open" && quarantineLeft(r.received, d) > 0));
  const money = seesMoney(ctx);
  const cols: ColSpec[] = [
    { k: "no", l: "Return", t: "mono" },
    { k: "stage", l: "Stage", t: "s" },
    { k: "customer", l: "Customer", t: "b" },
    { k: "sku", l: "Product", t: "t" },
    { k: "lot", l: "Batch", t: "mono" },
    { k: "qty", l: "Returned", t: "n" },
    { k: "quarantine", l: "In quarantine", t: "n" },
    { k: "unit", l: "Unit", t: "t" },
    { k: "credit", l: "Credit note", t: "s" },
    ...(money ? [{ k: "total", l: "Credit value", t: "m" as const }] : []),
    { k: "date", l: "Date", t: "d" },
    { k: "f", l: "Flags", t: "f" },
  ];
  return {
    spec: {
      screen: key,
      cols,
      hidden: money ? [] : [{ l: "Credit value", power: "viewPurchaseMoney" }],
      groups: ["stage", "customer"],
      chips: "stage",
      sortDefault: ["date", -1] as [string, 1 | -1],
      ...(key === "customerReturns" ? { newForm: await customerForm(), newLabel: "Record customer return" } : {}),
      noDataLine:
        key === "customerReturns"
          ? "No customer returns. Record one against the dispatched order line."
          : "Nothing in quarantine. Returned material waits here until QC decides.",
    },
    rows: list.map(({ r, d }) => customerRowFor(ctx, r, d, godowns)),
  };
}

/** Customer return's two approvals; the last needed raises the credit note through the complaint Accounts read. */
async function approveCredit(ctx: ErpContext, id: string, step: 1 | 2): Promise<Result<unknown>> {
  let complaintId: string | null = null;
  const res = await inTx(async (tx) => {
    const [r] = await customerRows(sql`r.id = ${id}`, tx);
    if (!r) return err("That return is gone.", "not_found");
    if (r.received == null || r.status !== "open") return err("A credit note is raised once the material has been received.", "conflict");
    if (r.complaintId) return err("Its credit note has already been raised.", "conflict");
    if (r.total == null) return err("The order line has no rate, so the credit note cannot be valued. Set the rate on the order first.", "rule_violation");
    if (step === 1 && r.approvedAt) return err("It has already had its first approval.", "conflict");
    if (step === 2 && (!r.approvedAt || !r.needsOwner || r.ownerApprovedAt)) return err("It is not waiting for the owner.", "conflict");
    const refusal = approvalRefusal({ step, actorId: ctx.actor.id, requesterId: r.requesterId, firstApproverId: null, administrator: ctx.administrator, hasPower: ctx.powers.has("returnApprove") });
    if (refusal) return err(refusal, "not_permitted");
    const now = new Date();
    if (step === 1) {
      const needsOwner = approvalSteps(r.total, await ownerLimit()) === 2;
      await tx.update(erpCustomerReturns).set({ approvedById: ctx.actor.id, approvedAt: now, needsOwner, updatedAt: now }).where(eq(erpCustomerReturns.id, id));
      if (needsOwner) return okVoid(`${customerReturnLabel(r.no)} approved — above the owner-approval limit, so the owner approves it next`);
    } else {
      await tx.update(erpCustomerReturns).set({ ownerApprovedById: ctx.actor.id, ownerApprovedAt: now, updatedAt: now }).where(eq(erpCustomerReturns.id, id));
    }
    /* The credit note is the Accounts one: a complaint asking for it, which
       Accounts issue against the bill (or on account) like every other. */
    const [bill] = await tx.select({ id: bills.id }).from(bills).where(eq(bills.externalRef, bookBillRef(r.orderNo)));
    complaintId = await createComplaint(
      {
        customerId: r.customerId,
        loggedById: ctx.actor.id,
        loggedByName: ctx.actor.name,
        category: complaintCategoryFor(r.reason),
        description: `Material returned: ${customerReturnLabel(r.no)} — ${nf(r.received)} ${r.unit.toLowerCase()} of ${r.sku}, lot ${r.lot}, on ${orderTraceCode(r.orderNo)}${r.billNo ? ` (bill ${r.billNo})` : ""}. Reason: ${reasonLabel(r.reason, "customer")}.${r.remarks ? ` ${r.remarks}` : ""}`,
        requestCn: true,
        billId: bill?.id ?? null,
        goodsDescription: `${customerReturnLabel(r.no)} · ${r.sku} · lot ${r.lot} · ${nf(r.received)} ${r.unit.toLowerCase()}`,
      },
      tx as never,
    );
    await tx.update(complaints).set({ cnAmount: r.total, cnStatus: "under_review", relatedOrderId: null, updatedAt: now }).where(eq(complaints.id, complaintId));
    await tx.update(erpCustomerReturns).set({ complaintId, updatedAt: now }).where(eq(erpCustomerReturns.id, id));
    return okVoid(`Credit note for ${inr(r.total)} raised to Accounts. No stock has moved — the material stays in quarantine until QC decides.`);
  });
  if (res.ok) await erpAudit(ctx, step === 1 ? "erp.customerReturn.approve" : "erp.customerReturn.ownerApprove", "erp_customer_return", id, null, { step, complaint: complaintId });
  return res;
}

/** QC's decision: posts into the EXISTING ledger the kind names, in one transaction. */
async function decide(ctx: ErpContext, id: string, v: Record<string, string>): Promise<Result<unknown>> {
  if (!decidesQc(ctx)) return err("QC decisions on returned material need the returns QC power.", "not_permitted");
  const kind = dispositionByLabel(v.kind ?? "");
  if (!kind) return fieldErr("kind", "Choose the decision.");
  const qty = num(v.qty) ?? 0;
  const godownId = kind === "waste" ? null : await godownIdByName(text(v.godown));
  const scrapKg = num(v.scrapKg);
  const dispId = erpId("erd");
  let summary = "";
  const res = await inTx(async (tx) => {
    const [r] = await customerRows(sql`r.id = ${id}`, tx);
    if (!r || r.status !== "open") return err("That return is not open.", "conflict");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"erp:customerReturn:" + id}))`);
    const ds = await decisionRows(sql`d.customer_return_id = ${id}`, tx);
    const left = quarantineLeft(r.received, ds);
    const refusal = dispositionRefusal({ kind, qty, left, whole: true, godownId, scrapKg, wasteReason: text(v.wasteReason) });
    if (refusal) return err(refusal, "validation");
    const litres = returnLitres({ qty, lotFrom: r.lotFrom, cansPerBox: r.cansPerBox, millilitres: r.millilitres });
    const day = today();
    let scrapEntryId: string | null = null;
    if (kind === "scrap") {
      scrapEntryId = erpId("scr");
      await tx.insert(erpScrapEntries).values({ id: scrapEntryId, entryDate: day, category: CHEMICAL_SCRAP, godownId: godownId!, quantity: r3(scrapKg!), unit: "Kg", note: `From customer return ${customerReturnLabel(r.no)} · ${r.sku} lot ${r.lot}`, createdById: ctx.actor.id });
    }
    await tx.insert(erpReturnDispositions).values({ id: dispId, customerReturnId: id, kind, quantity: qty, litres, godownId, scrapKg: kind === "scrap" ? r3(scrapKg!) : null, scrapEntryId, note: text(v.note), decidedById: ctx.actor.id });
    if (kind === "reuse") {
      /* The EXISTING FG item and lot: no new master, no new lot. */
      if (r.lotFrom === "pack") {
        await tx.insert(erpPackEntries).values({ id: erpId("epe"), sourceType: "return", sourceId: dispId, entryDate: day, skuId: r.skuId, batchNo: r.lot, godownId: godownId!, boxes: qty });
      } else {
        if (!r.fgId) refuse(err("This line names no finished good, so it cannot go back into FG stock.", "rule_violation"));
        const [last] = (await tx.execute(sql`select can_use_id as "canUseId", packing_type as "packingType", sku_id as "skuId" from erp_fg_entries where finished_good_id = ${r.fgId} and lot_code = ${r.lot} order by posted_at desc limit 1`)) as unknown as { canUseId: string | null; packingType: string | null; skuId: string | null }[];
        await tx.insert(erpFgEntries).values({ id: erpId("efe"), sourceType: "return", sourceId: dispId, entryDate: day, finishedGoodId: r.fgId!, lotCode: r.lot, godownId: godownId!, quantity: qty, canUseId: last?.canUseId ?? null, packingType: last?.packingType ?? null, skuId: last?.skuId ?? r.skuId });
      }
      await moveReturnUnits(tx, { orderId: r.orderId, lotFrom: r.lotFrom, lotCode: r.lot, qty, from: "returned", to: "available", godownId, note: `Reused from ${customerReturnLabel(r.no)}`, byId: ctx.actor.id });
      summary = `${nf(qty)} ${r.unit.toLowerCase()} back in FG stock (lot ${r.lot}) after QC`;
    } else {
      await moveReturnUnits(tx, { orderId: r.orderId, lotFrom: r.lotFrom, lotCode: r.lot, qty, from: "returned", to: "rejected", note: `${dispositionLabel(kind)} — ${customerReturnLabel(r.no)}`, byId: ctx.actor.id });
      if (kind === "rework") {
        if (!r.formulationId) refuse(err("This product names no SFG formulation, so it cannot be reworked through the SFG process.", "rule_violation"));
        const reworkNo = await nextNumber(tx, "reworkOrder");
        await tx.insert(erpReworkOrders).values({ id: erpId("erw"), reworkNo, dispositionId: dispId, customerReturnId: id, formulationId: r.formulationId!, godownId: godownId!, inputLitres: litres, sfgLotCode: reworkLotCode(reworkNo), createdById: ctx.actor.id });
        summary = `${reworkLabel(reworkNo)} opened for ${nf(litres)} L — complete it with the litres recovered`;
      } else if (kind === "scrap") {
        summary = `${nf(scrapKg!)} kg of Chemical Scrap recorded — it can be sold from Scrap sales`;
      } else {
        const wasteNo = await nextNumber(tx, "wasteDisposal");
        await tx.insert(erpWasteDisposals).values({ id: erpId("ewd"), wasteNo, dispositionId: dispId, customerReturnId: id, litres, reason: text(v.wasteReason)!, createdById: ctx.actor.id });
        summary = `${wasteLabel(wasteNo)} raised for ${nf(litres)} L — record the disposal when it is done`;
      }
    }
    return okVoid(summary);
  });
  if (res.ok) await erpAudit(ctx, "erp.customerReturn.decide", "erp_return_disposition", dispId, null, { return: id, kind, qty, godownId, scrapKg });
  return res;
}

/** Puts a decision's material back into quarantine. Refused where what it posted has since been used. */
async function reverseDecision(ctx: ErpContext, dispId: string, reason: string): Promise<Result<unknown>> {
  if (!decidesQc(ctx)) return err("Reversing a QC decision needs the returns QC power.", "not_permitted");
  if (reason.length < 10) return fieldErr("reason", "Say why (10 characters or more).");
  const res = await inTx(async (tx) => {
    const [d] = await tx.select().from(erpReturnDispositions).where(eq(erpReturnDispositions.id, dispId)).for("update");
    if (!d || d.status !== "active") return err("That decision is not active.", "conflict");
    const [r] = await customerRows(sql`r.id = ${d.customerReturnId}`, tx);
    const qty = Number(d.quantity);
    if (d.kind === "reuse") {
      if (r.lotFrom === "pack") {
        await lockLot(tx, "pack", r.lot, d.godownId!);
        const have = await packLotStock(r.lot, d.godownId!, tx);
        if (have + 1e-9 < qty) return err(`Only ${nf(have)} boxes of ${r.lot} are left at that godown — the rest has been used, so it cannot come back into quarantine.`, "rule_violation");
        await tx.delete(erpPackEntries).where(and(eq(erpPackEntries.sourceType, "return"), eq(erpPackEntries.sourceId, dispId)));
      } else {
        await lockLot(tx, "fg", r.lot, d.godownId!);
        const have = await fgLotStock(r.fgId!, r.lot, d.godownId!, tx);
        if (have + 1e-9 < qty) return err(`Only ${nf(have)} cans of ${r.lot} are left at that godown — the rest has been used, so it cannot come back into quarantine.`, "rule_violation");
        await tx.delete(erpFgEntries).where(and(eq(erpFgEntries.sourceType, "return"), eq(erpFgEntries.sourceId, dispId)));
      }
      await moveReturnUnits(tx, { orderId: r.orderId, lotFrom: r.lotFrom, lotCode: r.lot, qty, from: "available", to: "returned", note: `QC decision reversed — ${customerReturnLabel(r.no)}`, byId: ctx.actor.id });
    } else {
      if (d.kind === "scrap" && d.scrapEntryId) {
        const [e] = await tx.select().from(erpScrapEntries).where(eq(erpScrapEntries.id, d.scrapEntryId));
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"erp:scrap:" + CHEMICAL_SCRAP + ":Kg"}))`);
        await tx.update(erpScrapEntries).set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: new Date() }).where(eq(erpScrapEntries.id, d.scrapEntryId));
        const left = (await scrapStock(tx)).find((s) => s.category === CHEMICAL_SCRAP && s.unit === "Kg" && s.godownId === e?.godownId)?.available ?? 0;
        if (left < 0) return refuse(err("That chemical scrap has been sold since, so the decision cannot be reversed.", "rule_violation"));
      }
      if (d.kind === "rework") {
        const done = await tx.update(erpReworkOrders).set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: new Date() }).where(and(eq(erpReworkOrders.dispositionId, dispId), eq(erpReworkOrders.status, "open"))).returning({ id: erpReworkOrders.id });
        if (!done.length) return refuse(err("That rework has been completed — its recovered SFG is in stock, so it cannot be reversed.", "rule_violation"));
      }
      if (d.kind === "waste") {
        const done = await tx.update(erpWasteDisposals).set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: new Date() }).where(and(eq(erpWasteDisposals.dispositionId, dispId), eq(erpWasteDisposals.status, "pending"))).returning({ id: erpWasteDisposals.id });
        if (!done.length) return refuse(err("That waste has been disposed of, so it cannot come back into quarantine.", "rule_violation"));
      }
      await moveReturnUnits(tx, { orderId: r.orderId, lotFrom: r.lotFrom, lotCode: r.lot, qty, from: "rejected", to: "returned", note: `QC decision reversed — ${customerReturnLabel(r.no)}`, byId: ctx.actor.id });
    }
    await tx.update(erpReturnDispositions).set({ status: "reversed", reverseReason: reason, reversedById: ctx.actor.id, reversedAt: new Date() }).where(eq(erpReturnDispositions.id, dispId));
    return okVoid(`${dispositionLabel(d.kind)} reversed — ${nf(qty)} ${r.unit.toLowerCase()} back in quarantine`);
  });
  if (res.ok) await erpAudit(ctx, "erp.customerReturn.reverseDecision", "erp_return_disposition", dispId, { status: "active" }, { status: "reversed", reason });
  return res;
}

const customerActionHandlers: ScreenModule["actions"] = {
  async receive(ctx, id, v) {
    const qty = num(v.qty);
    const godownId = await godownIdByName(text(v.godown));
    if (!godownId) return fieldErr("godown", "Choose the godown it is held at.");
    const res = await inTx(async (tx) => {
      const [r] = await customerRows(sql`r.id = ${id}`, tx);
      if (!r || r.status !== "open" || r.received != null) return err("That return is not waiting to be received.", "conflict");
      if (qty == null || !(qty > 0) || !Number.isInteger(qty) || qty > r.qty) return err(`Enter the whole ${r.unit.toLowerCase()} received, up to ${nf(r.qty)}.`, "validation");
      await tx.update(erpCustomerReturns).set({ receivedQty: qty, receivedGodownId: godownId, receivedById: ctx.actor.id, receivedAt: new Date(), decisionNote: text(v.note), updatedAt: new Date() }).where(eq(erpCustomerReturns.id, id));
      await moveReturnUnits(tx, { orderId: r.orderId, lotFrom: r.lotFrom, lotCode: r.lot, qty, from: "dispatched", to: "returned", godownId, note: `Customer return ${customerReturnLabel(r.no)} — in quarantine`, byId: ctx.actor.id });
      return okVoid(`${nf(qty)} ${r.unit.toLowerCase()} received into quarantine. Not saleable until QC decides.`);
    });
    if (res.ok) await erpAudit(ctx, "erp.customerReturn.receive", "erp_customer_return", id, null, { qty, godownId });
    return res;
  },
  async reject(ctx, id, v) {
    if (!approves(ctx)) return err("Rejecting a return needs the returns power.", "not_permitted");
    const note = text(v.note);
    if (!note) return fieldErr("note", "Say why");
    const done = await db.update(erpCustomerReturns).set({ status: "rejected", decisionNote: note, updatedAt: new Date() }).where(and(eq(erpCustomerReturns.id, id), eq(erpCustomerReturns.status, "open"), sql`${erpCustomerReturns.receivedQty} is null`)).returning({ no: erpCustomerReturns.returnNo });
    if (!done.length) return err("Only a return not yet received can be rejected.", "conflict");
    await erpAudit(ctx, "erp.customerReturn.reject", "erp_customer_return", id, null, { note });
    return okVoid(`${customerReturnLabel(done[0].no)} rejected`);
  },
  approveCredit: (ctx, id) => approveCredit(ctx, id, 1),
  ownerApproveCredit: (ctx, id) => approveCredit(ctx, id, 2),
  decide: (ctx, id, v) => decide(ctx, id, v),
  async reverseDecision(ctx, id, v) {
    const ds = await decisionRows(sql`d.customer_return_id = ${id} and d.status = 'active'`);
    const [r] = await customerRows(sql`r.id = ${id}`);
    const d = ds.find((x) => decisionLine(x, (r?.unit ?? "").toLowerCase()) === v.decision);
    if (!d) return fieldErr("decision", "Choose the decision to reverse.");
    return reverseDecision(ctx, d.id, text(v.reason) ?? "");
  },
  async cancel(ctx, id, v) {
    const reason = text(v.reason);
    if (!reason) return fieldErr("reason", "Say why");
    const res = await inTx(async (tx) => {
      const [r] = await customerRows(sql`r.id = ${id}`, tx);
      if (!r || r.status !== "open") return err("That return is not open.", "conflict");
      const own = r.requesterId === ctx.user.id && r.received == null;
      if (!approves(ctx) && !own) return err("Cancelling a received return needs the returns power.", "not_permitted");
      if ((await decisionRows(sql`d.customer_return_id = ${id} and d.status = 'active'`, tx)).length) return err("QC has decided part of it — reverse those decisions first.", "conflict");
      if (r.cnStatus === "issued") return err("Its credit note has been issued — Accounts reverse it before the return can be cancelled.", "conflict");
      const now = new Date();
      await tx.update(erpCustomerReturns).set({ status: "cancelled", cancelReason: reason, cancelledById: ctx.actor.id, cancelledAt: now, updatedAt: now }).where(eq(erpCustomerReturns.id, id));
      if (r.complaintId) await tx.update(complaints).set({ cnStatus: "rejected", updatedAt: now }).where(eq(complaints.id, r.complaintId));
      if (r.received != null) await moveReturnUnits(tx, { orderId: r.orderId, lotFrom: r.lotFrom, lotCode: r.lot, qty: r.received, from: "returned", to: "dispatched", note: `Return ${customerReturnLabel(r.no)} cancelled`, byId: ctx.actor.id });
      return okVoid(`${customerReturnLabel(r.no)} cancelled — kept, marked cancelled`);
    });
    if (res.ok) await erpAudit(ctx, "erp.customerReturn.cancel", "erp_customer_return", id, null, { reason });
    return res;
  },
};

const customerReturns: ScreenModule = {
  key: "customerReturns",
  load: (ctx) => customerScreen(ctx, "customerReturns"),
  forms: {
    async new(ctx, h) {
      const lines = await returnableLines(undefined, { unallocatedDays: await unallocatedDays() });
      const line = lines.find((l) => lineOption(l) === h.line);
      if (!line) return fieldErr("line", "Choose the order line the material went out on.");
      const lotCode = line.lotCode ?? text(h.batch)?.toUpperCase() ?? null;
      if (!lotCode) return fieldErr("batch", "No lot was allocated on this line — enter the batch printed on the returned cans.");
      const qty = num(h.qty);
      if (qty == null) return fieldErr("qty", "Enter the quantity being returned.");
      const refusal = customerReturnRefusal({ qty, dispatched: line.sent, alreadyReturned: line.returned, whole: true });
      if (refusal) return fieldErr("qty", refusal);
      const reason = reasonByLabel(h.reason ?? "", "customer");
      if (!reason) return fieldErr("reason", "Choose a reason.");
      const litres = returnLitres({ qty, lotFrom: line.lotFrom, cansPerBox: line.cansPerBox, millilitres: line.millilitres });
      const v = returnValue({ qty: valuedQty(line, qty), ratePaise: line.ratePaise, gstBp: line.gstBp, discountBp: line.discountBp });
      const id = erpId("ecr");
      const res = await inTx(async (tx) => {
        const returnNo = await nextNumber(tx, "customerReturn");
        await tx.insert(erpCustomerReturns).values({
          id,
          returnNo,
          returnDate: text(h.date) ?? today(),
          customerId: line.customerId,
          orderId: line.orderId,
          batchCodeId: line.batchCodeId,
          skuId: line.skuId,
          finishedGoodId: line.finishedGoodId,
          lotFrom: line.lotFrom,
          lotCode,
          quantity: qty,
          unit: line.lotFrom === "pack" ? "Boxes" : "Cans",
          litres,
          ratePaise: line.ratePaise,
          discountBp: line.discountBp,
          gstBp: line.gstBp,
          totalPaise: v?.totalPaise ?? null,
          reasonCode: reason,
          customerRemarks: text(h.remarks),
          transporter: text(h.transporter),
          vehicleNo: text(h.vehicle),
          lrNo: text(h.lr),
          createdById: ctx.actor.id,
        });
        await bindErpFiles(tx as unknown as typeof db, [text(h.photo)], "erp_customer_return", id, ctx.actor.id);
        return okVoid(`${customerReturnLabel(returnNo)} recorded — receive it into quarantine when it arrives`);
      });
      if (res.ok) await erpAudit(ctx, "erp.customerReturn.create", "erp_customer_return", id, null, { order: line.orderNo, lot: lotCode, allocated: line.batchCodeId != null, qty, reason, total: v?.totalPaise ?? null });
      return res;
    },
  },
  actions: customerActionHandlers,
};

const returnQc: ScreenModule = {
  key: "returnQc",
  load: (ctx) => customerScreen(ctx, "returnQc"),
  actions: customerActionHandlers,
};

/* ------------------------------------------------------------------ rework */

const reworkOrders: ScreenModule = {
  key: "reworkOrders",
  async load(ctx) {
    const rows = (await db.execute(sql`
      select w.id, w.rework_no as no, w.status, w.customer_return_id as "returnId", r.return_no as "returnNo", f.name as product,
             g.name as godown, w.input_litres::float8 as input, w.output_litres::float8 as output, w.loss_litres::float8 as loss,
             w.sfg_lot_code as lot, w.operator, w.rework_date::text as date, w.note, q.status as qc, w.cancel_reason as "cancelReason",
             uc.name as completer, w.completed_at as "completedAt", u.name as by, w.created_at as "createdAt", r.lot_code as "returnLot"
        from erp_rework_orders w
        join erp_customer_returns r on r.id = w.customer_return_id
        join product_formulations f on f.id = w.formulation_id
        join erp_godowns g on g.id = w.godown_id
        left join erp_sfg_qc q on q.lot_code = w.sfg_lot_code
        left join users uc on uc.id = w.completed_by_id
        left join users u on u.id = w.created_by_id
       order by w.created_at desc
    `)) as unknown as Row[];
    const word = (s: string) => (s === "open" ? "In rework" : s === "completed" ? "Completed" : "Cancelled");
    return {
      spec: {
        screen: "reworkOrders",
        cols: [
          { k: "no", l: "Rework", t: "mono" },
          { k: "status", l: "Status", t: "s" },
          { k: "product", l: "SFG product", t: "b" },
          { k: "input", l: "Input (L)", t: "n" },
          { k: "output", l: "Recovered (L)", t: "n" },
          { k: "loss", l: "Process loss (L)", t: "n" },
          { k: "lot", l: "SFG lot", t: "mono" },
          { k: "godown", l: "Godown", t: "t" },
          { k: "ret", l: "Return", t: "mono" },
        ],
        hidden: [],
        groups: ["status"],
        chips: "status",
        godownKey: "godown",
        noDataLine: "No rework. QC opens one when returned material can be recovered.",
      },
      rows: rows.map((r): ListRow => {
        const open = r.status === "open";
        return {
          id: String(r.id),
          v: { no: reworkLabel(Number(r.no)), status: word(String(r.status)), product: String(r.product), input: Number(r.input), output: r.output == null ? null : Number(r.output), loss: r.loss == null ? null : Number(r.loss), lot: String(r.lot), godown: String(r.godown), ret: customerReturnLabel(Number(r.returnNo)) },
          flags: r.status === "completed" && r.qc !== "Approved" ? (r.qc === "Rejected" ? ["qcRejected"] : ["qcPending"]) : [],
          title: `${reworkLabel(Number(r.no))} · ${r.product}`,
          header: `From ${customerReturnLabel(Number(r.returnNo))} (lot ${r.returnLot}) · ${word(String(r.status))}`,
          fields: [
            { l: "Return batch", v: `${customerReturnLabel(Number(r.returnNo))} · lot ${r.returnLot}` },
            { l: "Input", v: `${nf(Number(r.input))} L` },
            { l: "SFG output", v: r.output == null ? "Not completed" : `${nf(Number(r.output))} L as SFG lot ${r.lot}` },
            { l: "Process loss", v: r.loss == null ? "—" : `${nf(Number(r.loss))} L` },
            { l: "Operator · date", v: [r.operator, r.date ? fd(String(r.date)) : null].filter(Boolean).join(" · ") || "—" },
            { l: "QC approval", v: r.status === "completed" ? `${r.qc ?? "Pending"} — the SFG lot is filled only once SFG QC approves it` : "After completion, on SFG batches" },
            ...(r.completedAt ? [{ l: "Completed", v: `${r.completer ?? "—"} · ${stampLine(null, r.completedAt as Date).replace(/^Created /, "")}` }] : []),
            ...(r.note ? [{ l: "Note", v: String(r.note) }] : []),
            ...(r.cancelReason ? [{ l: "Cancelled because", v: String(r.cancelReason) }] : []),
          ],
          actions: [
            ...(open
              ? [
                  {
                    id: "complete",
                    l: "Complete the rework",
                    primary: true,
                    why: why(decidesQc(ctx), "Completing a rework needs the returns QC power"),
                    prompt: {
                      title: `Complete ${reworkLabel(Number(r.no))}`,
                      sub: `${nf(Number(r.input))} L went in. What is recovered is posted as SFG lot ${r.lot}, which SFG QC approves before it is filled; the rest is process loss.`,
                      submit: "Complete",
                      init: { date: today() },
                      fields: [
                        { k: "output", l: "Recovered SFG (L)", t: "num", req: true, min: 0, max: Number(r.input) },
                        { k: "operator", l: "Operator", t: "text", req: true },
                        { k: "date", l: "Date", t: "date", req: true },
                        { k: "note", l: "Note", t: "area" },
                      ],
                    } as ActionSpec["prompt"],
                  },
                ]
              : []),
            { id: "openReturn", l: `Open ${customerReturnLabel(Number(r.returnNo))}`, href: erpLink("customerReturns", { open: String(r.returnId) }) },
            ...(r.status === "completed" ? [{ id: "openSfg", l: `Open SFG lot ${r.lot}`, href: erpLink("sfgStock", { q: String(r.lot) }) }] : []),
          ],
          by: stampLine(r.by as string | null, r.createdAt as Date),
        };
      }),
    };
  },
  actions: {
    async complete(ctx, id, v) {
      if (!decidesQc(ctx)) return err("Completing a rework needs the returns QC power.", "not_permitted");
      const output = num(v.output);
      const operator = text(v.operator);
      if (!operator) return fieldErr("operator", "Who did the rework?");
      let label = "";
      const res = await inTx(async (tx) => {
        const [w] = await tx.select().from(erpReworkOrders).where(eq(erpReworkOrders.id, id)).for("update");
        if (!w || w.status !== "open") return err("That rework is not open.", "conflict");
        const fig = reworkFigures(Number(w.inputLitres), output ?? -1);
        if ("refusal" in fig) return err(fig.refusal, "validation");
        const day = text(v.date) ?? today();
        await tx.update(erpReworkOrders).set({ status: "completed", outputLitres: output!, lossLitres: fig.lossLitres, operator, reworkDate: day, note: text(v.note), completedById: ctx.actor.id, completedAt: new Date() }).where(eq(erpReworkOrders.id, id));
        if (output! > 0) {
          /* The EXISTING SFG process: its own lot, held Pending until SFG QC approves it. */
          await tx.insert(erpSfgEntries).values({ id: erpId("ese"), sourceType: "rework", sourceId: id, entryDate: day, formulationId: w.formulationId, lotCode: w.sfgLotCode, godownId: w.godownId, quantity: output!, remark: `Rework ${reworkLabel(w.reworkNo)}` });
          await tx.execute(sql`insert into erp_sfg_qc (lot_code, status) values (${w.sfgLotCode}, 'Pending') on conflict do nothing`);
        }
        label = reworkLabel(w.reworkNo);
        return okVoid(`${label} completed: ${nf(output!)} L recovered as SFG lot ${w.sfgLotCode}, ${nf(fig.lossLitres)} L process loss. SFG QC approves the lot before it is filled.`);
      });
      if (res.ok) await erpAudit(ctx, "erp.rework.complete", "erp_rework_order", id, { status: "open" }, { status: "completed", output, operator });
      return res;
    },
  },
};

/* --------------------------------------------------------------- waste */

const WASTE_METHODS = ["Authorised disposal agency", "Effluent treatment", "Incineration", "Secured landfill", "Other"];

const wasteDisposals: ScreenModule = {
  key: "wasteDisposals",
  async load(ctx) {
    const rows = (await db.execute(sql`
      select x.id, x.waste_no as no, x.status, x.customer_return_id as "returnId", r.return_no as "returnNo", r.lot_code as lot, p.name as sku,
             x.litres::float8 as litres, x.reason, x.disposal_date::text as date, x.method, x.responsible, x.agency, x.cost_paise::float8 as cost,
             x.note, x.cancel_reason as "cancelReason", ud.name as disposer, x.disposed_at as "disposedAt", u.name as by, x.created_at as "createdAt"
        from erp_waste_disposals x
        join erp_customer_returns r on r.id = x.customer_return_id
        join products p on p.id = r.sku_id
        left join users ud on ud.id = x.disposed_by_id
        left join users u on u.id = x.created_by_id
       order by x.created_at desc
    `)) as unknown as Row[];
    const word = (s: string) => (s === "pending" ? "To dispose" : s === "disposed" ? "Disposed" : "Cancelled");
    return {
      spec: {
        screen: "wasteDisposals",
        cols: [
          { k: "no", l: "Waste", t: "mono" },
          { k: "status", l: "Status", t: "s" },
          { k: "sku", l: "Product", t: "b" },
          { k: "litres", l: "Quantity (L)", t: "n" },
          { k: "method", l: "Method", t: "t" },
          { k: "date", l: "Disposed", t: "d" },
          { k: "cost", l: "Cost", t: "m" },
          { k: "ret", l: "Return", t: "mono" },
        ],
        hidden: [],
        groups: ["status"],
        chips: "status",
        noDataLine: "No waste. Material that cannot be reused or sold is disposed of here.",
      },
      rows: rows.map((r): ListRow => ({
        id: String(r.id),
        v: { no: wasteLabel(Number(r.no)), status: word(String(r.status)), sku: String(r.sku), litres: Number(r.litres), method: (r.method as string | null) ?? "", date: (r.date as string | null) ?? null, cost: r.cost == null ? null : Number(r.cost), ret: customerReturnLabel(Number(r.returnNo)) },
        flags: [],
        title: `${wasteLabel(Number(r.no))} · ${r.sku}`,
        header: `From ${customerReturnLabel(Number(r.returnNo))} (lot ${r.lot}) · ${word(String(r.status))}`,
        fields: [
          { l: "Waste quantity", v: `${nf(Number(r.litres))} L` },
          { l: "Reason", v: String(r.reason) },
          { l: "Disposal", v: r.status === "disposed" ? `${fd(String(r.date))} · ${r.method}${r.agency ? ` · ${r.agency}` : ""}` : "Not disposed yet" },
          ...(r.responsible ? [{ l: "Responsible person", v: String(r.responsible) }] : []),
          ...(r.cost != null ? [{ l: "Disposal cost", v: inr(Number(r.cost)) }] : []),
          ...(r.note ? [{ l: "Note", v: String(r.note) }] : []),
          ...(r.disposedAt ? [{ l: "Recorded", v: `${r.disposer ?? "—"} · ${stampLine(null, r.disposedAt as Date).replace(/^Created /, "")}` }] : []),
          ...(r.cancelReason ? [{ l: "Cancelled because", v: String(r.cancelReason) }] : []),
        ],
        actions: [
          ...(r.status === "pending"
            ? [
                {
                  id: "dispose",
                  l: "Record the disposal",
                  primary: true,
                  why: why(decidesQc(ctx), "Recording a disposal needs the returns QC power"),
                  prompt: {
                    title: `Dispose of ${wasteLabel(Number(r.no))}`,
                    sub: `${nf(Number(r.litres))} L of ${r.sku}. It is never shown as saleable stock.`,
                    submit: "Record disposal",
                    init: { date: today() },
                    fields: [
                      { k: "date", l: "Disposal date", t: "date", req: true },
                      { k: "method", l: "Disposal method", t: "select", req: true, opts: WASTE_METHODS },
                      { k: "responsible", l: "Responsible person", t: "text", req: true },
                      { k: "agency", l: "Disposal vendor / agency", t: "text" },
                      { k: "cost", l: "Disposal cost (₹)", t: "num", min: 0 },
                      { k: "note", l: "Note", t: "area" },
                      { k: "file", l: "Certificate / receipt", t: "photo" },
                    ],
                  } as ActionSpec["prompt"],
                },
              ]
            : []),
          { id: "openReturn", l: `Open ${customerReturnLabel(Number(r.returnNo))}`, href: erpLink("customerReturns", { open: String(r.returnId) }) },
        ],
        by: stampLine(r.by as string | null, r.createdAt as Date),
      })),
    };
  },
  actions: {
    async dispose(ctx, id, v) {
      if (!decidesQc(ctx)) return err("Recording a disposal needs the returns QC power.", "not_permitted");
      const method = text(v.method);
      if (!method || !WASTE_METHODS.includes(method)) return fieldErr("method", "Choose the disposal method.");
      const responsible = text(v.responsible);
      if (!responsible) return fieldErr("responsible", "Who is responsible for it?");
      const cost = paise(v.cost);
      if (cost != null && cost < 0) return fieldErr("cost", "A cost cannot be negative.");
      const res = await inTx(async (tx) => {
        const done = await tx
          .update(erpWasteDisposals)
          .set({ status: "disposed", disposalDate: text(v.date) ?? today(), method, responsible, agency: text(v.agency), costPaise: cost, note: text(v.note), disposedById: ctx.actor.id, disposedAt: new Date() })
          .where(and(eq(erpWasteDisposals.id, id), eq(erpWasteDisposals.status, "pending")))
          .returning({ no: erpWasteDisposals.wasteNo });
        if (!done.length) return err("That waste is not waiting for disposal.", "conflict");
        await bindErpFiles(tx as unknown as typeof db, [text(v.file)], "erp_waste", id, ctx.actor.id);
        return okVoid(`${wasteLabel(done[0].no)} disposed of and recorded`);
      });
      if (res.ok) await erpAudit(ctx, "erp.waste.dispose", "erp_waste_disposal", id, { status: "pending" }, { status: "disposed", method, responsible, cost });
      return res;
    },
  },
};


export const RETURN_SCREENS: ScreenModule[] = [vendorReturns, debitNotes, returnOutwards, customerReturns, returnQc, reworkOrders, wasteDisposals];
