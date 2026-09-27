import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { erpAiSuggestions, erpPurchases, erpSuppliers } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { decideSuggestion, featureState, logSuggestion, outcomeOf, readImages } from "./ai";
import { bindErpFiles } from "./attachments";
import { purchaseFigures } from "./engines/purchase";
import { bestMatches, sameGstin } from "./engines/match";
import { erpAudit, num, paise, text } from "./server";
import type { FormSpec, Tone } from "./ui";
import { inr, nf } from "./ui";
import { syncPurchaseEntryPublic } from "./screens/purchase";

/* ---------------------------------------------------------------------------
 * AI-1, supplier bill reading. The model READS the bill; which register row a
 * line belongs to, whether the quantity or rate is unusual and whether the
 * bill number was used before are decided here by rules. Nothing is written
 * until a person saves the review, and then it goes through the register's
 * own rules — a rate above zero posts to stock, exactly as typed by hand.
 * ------------------------------------------------------------------------- */

const Conf = z.enum(["high", "check", "not found"]);
const BillSchema = z.object({
  supplierName: z.string().nullable(),
  supplierGstin: z.string().nullable(),
  billNo: z.string().nullable(),
  billDate: z.string().nullable().describe("YYYY-MM-DD"),
  billNoConfidence: Conf,
  billDateConfidence: Conf,
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().nullable(),
      unit: z.string().nullable().describe("as printed: kg, ltr, pcs"),
      rate: z.number().nullable().describe("rupees per unit, before GST"),
      gstPercent: z.number().nullable(),
      amount: z.number().nullable().describe("line total as printed"),
      confidence: Conf,
    }),
  ),
  billTotal: z.number().nullable(),
  freight: z.number().nullable(),
});
export type Bill = z.infer<typeof BillSchema>;

type ProposedLine = { purchaseId: string; lot: string; item: string; qty: number | null; unit: string; rate: number | null; gst: number | null; conf: string; flags: string[] };
type Proposal = { pr: number; billNo: string | null; billDate: string | null; conf: Record<string, string>; lines: ProposedLine[]; flags: { tone: Tone; text: string }[]; fileIds: string[] };

/** Reads the bill photographed for this register row's PR and stores the proposal. */
export async function readBill(ctx: ErpContext, purchaseId: string, fileIds: string[]): Promise<Result<unknown>> {
  if (!ctx.powers.has("viewPurchaseMoney")) return err("Reading a bill fills rates, so it needs purchase money on your account.", "not_permitted");
  const state = await featureState("bills", true);
  if (!state.on) return err(state.reason, "rule_violation");
  if (!fileIds.length) return fieldErr("photo", "Photograph or upload the bill");
  const [anchor] = await db.select().from(erpPurchases).where(eq(erpPurchases.id, purchaseId));
  if (!anchor) return err("That purchase no longer exists.", "not_found");
  await bindErpFiles(db, fileIds, "erp_purchase", purchaseId, ctx.user.id);

  const read = await readImages({
    label: "ERP bill",
    system:
      "You read Indian supplier tax invoices for a paint manufacturer. Transcribe exactly what is printed: never compute, convert or infer a number, and never invent a line. Rates are per unit before GST. Where a value is not printed, answer null and mark its confidence 'not found'. Mark 'check' where the print is unclear.",
    instruction: "Read this supplier bill: supplier, GSTIN, bill number and date, every item line, the bill total and any freight.",
    schema: BillSchema,
    attachmentIds: fileIds,
  });
  if (!read.output) return err(read.error ?? "The bill could not be read. Enter the values by hand.", "rule_violation");
  return recordBillReading(ctx, anchor, read.output, fileIds, read.model);
}

/**
 * The rules' half of a reading: match and flag what the model read, and store
 * it as a pending suggestion. Separate from the model call so it can be tested
 * on a reading nobody had to pay for.
 */
export async function recordBillReading(ctx: ErpContext, anchor: typeof erpPurchases.$inferSelect, bill: Bill, fileIds: string[], servedBy: string | null): Promise<Result<unknown>> {
  const proposal = await propose(anchor, bill, fileIds);
  await logSuggestion({ feature: "bills", recordType: "erp_purchase", recordId: anchor.id, inputRef: fileIds.join(","), proposed: proposal as unknown as Record<string, unknown>, confidence: proposal.conf, servedBy, userId: ctx.user.id });
  const problems = proposal.flags.filter((f) => f.tone !== "success").length;
  return okVoid(`Bill read · ${proposal.lines.length} line${proposal.lines.length === 1 ? "" : "s"} matched${problems ? ` · ${problems} to check` : ""}. Open "Review bill reading" on the row.`);
}

/** The deterministic half: match the supplier and each line, and flag what is unusual. */
async function propose(anchor: typeof erpPurchases.$inferSelect, bill: Bill, fileIds: string[]): Promise<Proposal> {
  const c = await getConfig();
  const flags: { tone: Tone; text: string }[] = [];
  const [supplier] = await db.select().from(erpSuppliers).where(eq(erpSuppliers.id, anchor.supplierId));
  const gstOk = sameGstin(bill.supplierGstin, supplier?.gstin);
  if (bill.supplierGstin && supplier?.gstin && !gstOk) flags.push({ tone: "danger", text: `The bill's GSTIN ${bill.supplierGstin} is not ${supplier.name}'s (${supplier.gstin}).` });
  else if (!gstOk && bill.supplierName && supplier && (bestMatches(bill.supplierName, [supplier.name], (s) => s).choices[0]?.score ?? 0) < 0.5) flags.push({ tone: "warn", text: `The bill names "${bill.supplierName}", not ${supplier.name}. Check it is the right bill.` });

  const rows = (await db.execute(sql`
    select p.id, p.lot_no as lot, p.quantity::float8 as qty, p.unit, p.rate_paise::float8 as rate, m.name as item, m.code as code
      from erp_purchases p join erp_raw_materials m on m.id = p.raw_material_id
     where p.pr_number = ${anchor.prNumber} and p.supplier_id = ${anchor.supplierId}
  `)) as unknown as { id: string; lot: string; qty: number; unit: string; rate: number | null; item: string; code: string | null }[];

  const used = new Set<string>();
  const lines: ProposedLine[] = [];
  for (const l of bill.lines) {
    const m = bestMatches(l.description, rows.filter((r) => !used.has(r.id)), (r) => `${r.item} ${r.code ?? ""}`, { minScore: 0.5 });
    const row = m.sure ?? ((m.choices[0]?.score ?? 0) >= 0.4 ? m.choices[0].item : null);
    if (!row) {
      flags.push({ tone: "warn", text: `"${l.description}" on the bill has no register row in PR ${anchor.prNumber}.` });
      continue;
    }
    used.add(row.id);
    const lf: string[] = [];
    if (l.quantity != null && row.qty > 0 && (Math.abs(l.quantity - row.qty) / row.qty) * 100 > c["erp.ai.bill.qtyTolerancePct"]) lf.push(`bill says ${nf(l.quantity)}, the register ${nf(row.qty)}`);
    const [last] = (await db.execute(sql`
      select rate_paise::float8 as rate from erp_purchases
       where supplier_id = ${anchor.supplierId} and raw_material_id = (select raw_material_id from erp_purchases where id = ${row.id})
         and id <> ${row.id} and rate_paise > 0 order by purchase_date desc, created_at desc limit 1
    `)) as unknown as { rate: number }[];
    if (l.rate != null && last && (Math.abs(l.rate * 100 - last.rate) / last.rate) * 100 > c["erp.ai.bill.rateDeviationPct"]) lf.push(`rate ₹${nf(l.rate)} against last ${inr(last.rate)}`);
    if (l.gstPercent != null && l.gstPercent !== 18) lf.push(`GST ${l.gstPercent}%, not 18%`);
    lines.push({ purchaseId: row.id, lot: row.lot, item: row.item, qty: l.quantity, unit: row.unit, rate: l.rate, gst: l.gstPercent, conf: l.confidence, flags: lf });
    lf.forEach((t) => flags.push({ tone: "warn", text: `${row.item}: ${t}.` }));
  }
  for (const r of rows) if (!used.has(r.id)) flags.push({ tone: "warn", text: `${r.item} (lot ${r.lot}) is in PR ${anchor.prNumber} but not on the bill.` });

  if (bill.billNo) {
    const [dup] = (await db.execute(sql`select 1 from erp_purchases where supplier_id = ${anchor.supplierId} and bill_number = ${bill.billNo} and pr_number <> ${anchor.prNumber} limit 1`)) as unknown as unknown[];
    if (dup) flags.push({ tone: "danger", text: `Bill ${bill.billNo} is already recorded against another PR from this supplier.` });
  }
  const sum = bill.lines.reduce((a, l) => a + (l.amount ?? 0), 0) + (bill.freight ?? 0);
  if (bill.billTotal != null && sum > 0) {
    const withGst = bill.lines.reduce((a, l) => a + (l.amount ?? 0) * (1 + (l.gstPercent ?? 0) / 100), 0) + (bill.freight ?? 0);
    if (Math.abs(sum - bill.billTotal) > 1 && Math.abs(withGst - bill.billTotal) > 1) flags.push({ tone: "warn", text: `The lines add up to ₹${nf(Math.round(sum))} (₹${nf(Math.round(withGst))} with GST), but the bill total is ₹${nf(bill.billTotal)}.` });
  }
  if (!flags.length) flags.push({ tone: "success", text: "Supplier, lines and totals agree with the register." });
  return { pr: anchor.prNumber, billNo: bill.billNo, billDate: bill.billDate, conf: { billNo: bill.billNoConfidence, billDate: bill.billDateConfidence }, lines, flags, fileIds };
}

/** The review form: the bill beside the proposed values, one line per register row. */
export async function billReviewForm(purchaseId: string): Promise<FormSpec | null> {
  const [s] = await db
    .select()
    .from(erpAiSuggestions)
    .where(and(eq(erpAiSuggestions.feature, "bills"), eq(erpAiSuggestions.recordId, purchaseId), eq(erpAiSuggestions.outcome, "pending")))
    .orderBy(sql`${erpAiSuggestions.createdAt} desc`)
    .limit(1);
  if (!s) return null;
  const p = s.proposed as unknown as Proposal;
  const conf = (k: string) => ((p.conf[k] as "high" | "check" | "not found") ?? "check");
  return {
    screen: "register",
    id: "aiBill",
    recordId: s.id,
    title: `Review the bill for PR ${p.pr}`,
    sub: "Every value is the model's reading. Correct anything that differs from the bill, then save — or reject the reading.",
    submit: "Save to the register",
    init: { billNo: p.billNo ?? "", billDate: p.billDate ?? "" },
    header: [
      { k: "billNo", l: "Bill number", t: "text", req: true, conf: conf("billNo") },
      { k: "billDate", l: "Bill date", t: "date", conf: conf("billDate") },
    ],
    lineLabel: "Register row",
    line: [
      { k: "lot", l: "Lot", t: "text", readOnly: true },
      { k: "item", l: "Item", t: "text", readOnly: true },
      { k: "qty", l: "Quantity", t: "num", req: true, min: 0.001 },
      { k: "rate", l: "Rate (₹, before GST)", t: "num", req: true, min: 0.01 },
      { k: "gst", l: "GST %", t: "num", req: true, min: 0, max: 100 },
    ],
    initLines: p.lines.map((l) => ({ lot: l.lot, item: l.item, qty: l.qty == null ? "" : String(l.qty), rate: l.rate == null ? "" : String(l.rate), gst: l.gst == null ? "18" : String(l.gst) })),
    evidence: { images: p.fileIds, flags: p.flags, note: p.lines.some((l) => l.conf !== "high") ? "Lines marked unclear on the bill need checking one by one." : undefined },
  };
}

/** Saves the reviewed values through the register's own rules, and logs what the person changed. */
export async function applyBill(ctx: ErpContext, suggestionId: string, h: Record<string, string>, lines: Record<string, string>[]): Promise<Result<unknown>> {
  if (!ctx.powers.has("viewPurchaseMoney")) return err("Purchase money is not on your account.", "not_permitted");
  const [s] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, suggestionId));
  if (!s || s.outcome !== "pending") return err("That reading has already been decided.", "conflict");
  const p = s.proposed as unknown as Proposal;
  const billNo = text(h.billNo);
  if (!billNo) return fieldErr("billNo", "Bill number is required");
  const byLot = new Map(p.lines.map((l) => [l.lot, l]));
  const updates: { id: string; qty: number; rate: number; gst: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const orig = byLot.get(l.lot ?? "");
    if (!orig) return err("A line does not belong to this reading.", "rule_violation");
    const qty = num(l.qty);
    const rate = paise(l.rate);
    const gst = num(l.gst);
    if (qty == null || qty <= 0) return fieldErr(`l${i}.qty`, "Quantity is required");
    if (rate == null || rate <= 0) return fieldErr(`l${i}.rate`, "Rate is required");
    if (gst == null || gst < 0 || gst > 100) return fieldErr(`l${i}.gst`, "GST % is required");
    updates.push({ id: orig.purchaseId, qty, rate, gst: Math.round(gst * 100) });
  }
  await db.transaction(async (tx) => {
    for (const u of updates) {
      const [row] = await tx.select().from(erpPurchases).where(eq(erpPurchases.id, u.id));
      if (!row) continue;
      const fig = purchaseFigures({ quantity: u.qty, unit: row.unit, ratePaise: u.rate, density: row.density, feedAdjustedLitre: row.feedAdjustedLitre, feedAdjustedAmountPaise: row.feedAdjustedAmountPaise, gstBp: u.gst, drums: row.drums });
      await tx
        .update(erpPurchases)
        .set({ quantity: u.qty, ratePaise: u.rate, gstBp: u.gst, billNumber: billNo, billReceived: "Received", availableLitres: fig.availableLitres, aiFilled: true, updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(erpPurchases.id, u.id));
      await syncPurchaseEntryPublic(tx, u.id);
    }
  });
  const final = { billNo, billDate: text(h.billDate), lines: lines.map((l) => ({ lot: l.lot, qty: l.qty, rate: l.rate, gst: l.gst })) };
  const proposedFlat = { billNo: p.billNo, billDate: p.billDate, lines: JSON.stringify(p.lines.map((l) => ({ lot: l.lot, qty: l.qty == null ? "" : String(l.qty), rate: l.rate == null ? "" : String(l.rate), gst: l.gst == null ? "18" : String(l.gst) }))) };
  const finalFlat = { billNo, billDate: text(h.billDate), lines: JSON.stringify(final.lines) };
  const outcome = outcomeOf(proposedFlat, finalFlat);
  await decideSuggestion(suggestionId, outcome, final);
  await erpAudit(ctx, "erp.ai.bill.apply", "erp_purchase", updates.map((u) => u.id).join(","), null, { suggestionId, outcome });
  return okVoid(`Bill ${billNo} saved on ${updates.length} row${updates.length === 1 ? "" : "s"} · rated rows are in stock${outcome === "edited" ? " · your corrections were logged" : ""}`);
}

export async function rejectBill(ctx: ErpContext, purchaseId: string): Promise<Result<unknown>> {
  const [s] = await db
    .select({ id: erpAiSuggestions.id })
    .from(erpAiSuggestions)
    .where(and(eq(erpAiSuggestions.feature, "bills"), eq(erpAiSuggestions.recordId, purchaseId), eq(erpAiSuggestions.outcome, "pending")));
  if (!s) return err("There is no reading to reject.", "not_found");
  await decideSuggestion(s.id, "rejected");
  await erpAudit(ctx, "erp.ai.bill.reject", "erp_purchase", purchaseId, null, { suggestionId: s.id });
  return okVoid("Reading rejected · nothing was changed");
}

