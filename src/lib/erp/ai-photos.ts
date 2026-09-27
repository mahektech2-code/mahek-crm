import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { erpAiSuggestions, erpRawMaterials, erpTests, erpTransports } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { decideSuggestion, featureState, logSuggestion, outcomeOf, readImages } from "./ai";
import { bindErpFiles } from "./attachments";
import { similarity } from "./engines/match";
import { erpAudit, num, text } from "./server";
import type { FormSpec, Tone } from "./ui";

/* ---------------------------------------------------------------------------
 * AI-8: reading an LR number off a lorry receipt, and test readings off the
 * test photographs. The model reads; the checks — does the transporter match,
 * is the LR number already used, how far is the density from the master — are
 * rules. The AI never sets a verification status: that stays the verifier's.
 * ------------------------------------------------------------------------- */

const Conf = z.enum(["high", "check", "not found"]);

/* ================================================================== LR */

const LrSchema = z.object({
  lrNo: z.string().nullable(),
  lrConfidence: Conf,
  transporter: z.string().nullable(),
  date: z.string().nullable().describe("YYYY-MM-DD"),
});
export type LrReading = z.infer<typeof LrSchema>;
type LrProposal = LrReading & { flags: { tone: Tone; text: string }[]; fileId: string };

export async function readLr(ctx: ErpContext, transportId: string, fileId: string | null): Promise<Result<unknown>> {
  const state = await featureState("photos", true);
  if (!state.on) return err(state.reason, "rule_violation");
  if (!fileId) return fieldErr("photo", "Photograph the lorry receipt");
  const [t] = await db.select().from(erpTransports).where(eq(erpTransports.id, transportId));
  if (!t) return err("That bill is not in transport follow-up.", "not_found");
  await bindErpFiles(db, [fileId], "erp_transport", transportId, ctx.user.id);
  const read = await readImages({
    label: "ERP LR",
    system: "You read Indian lorry receipts (LR / GR / consignment notes). Transcribe exactly what is printed. The LR number is the consignment note number, not a phone or GST number. Answer null and 'not found' where it is not printed.",
    instruction: "Read the LR number, the transport company's name and the date on this lorry receipt.",
    schema: LrSchema,
    attachmentIds: [fileId],
  });
  if (!read.output) return err(read.error ?? "The receipt could not be read. Enter the LR by hand.", "rule_violation");
  return recordLrReading(ctx, t, read.output, fileId, read.model);
}

export async function recordLrReading(ctx: ErpContext, t: typeof erpTransports.$inferSelect, r: LrReading, fileId: string, servedBy: string | null): Promise<Result<unknown>> {
  const flags: { tone: Tone; text: string }[] = [];
  if (r.transporter && t.transporter && similarity(t.transporter, r.transporter) < 0.5)
    flags.push({ tone: "warn", text: `The receipt is from "${r.transporter}", but the bill goes by ${t.transporter}.` });
  if (r.lrNo) {
    const [dup] = await db.select({ id: erpTransports.id, orderNo: erpTransports.orderNo }).from(erpTransports).where(and(eq(erpTransports.lrNo, r.lrNo), ne(erpTransports.id, t.id)));
    if (dup) flags.push({ tone: "danger", text: `LR ${r.lrNo} is already recorded on order ${dup.orderNo}.` });
  }
  if (!flags.length) flags.push({ tone: "success", text: "The transporter matches and the LR number is new." });
  const proposal: LrProposal = { ...r, flags, fileId };
  await logSuggestion({ feature: "photos", recordType: "erp_transport", recordId: t.id, inputRef: fileId, proposed: proposal as unknown as Record<string, unknown>, confidence: { lrNo: r.lrConfidence }, servedBy, userId: ctx.user.id });
  return okVoid(r.lrNo ? `Read LR ${r.lrNo}. Open "Review LR reading" to confirm it.` : "No LR number could be read. Enter it by hand.");
}

async function pending(recordId: string) {
  const [s] = await db
    .select()
    .from(erpAiSuggestions)
    .where(and(eq(erpAiSuggestions.feature, "photos"), eq(erpAiSuggestions.recordId, recordId), eq(erpAiSuggestions.outcome, "pending")))
    .orderBy(sql`${erpAiSuggestions.createdAt} desc`)
    .limit(1);
  return s ?? null;
}

export async function lrReviewForm(screen: string, transportId: string): Promise<FormSpec | null> {
  const s = await pending(transportId);
  if (!s) return null;
  const p = s.proposed as unknown as LrProposal;
  return {
    screen,
    id: "aiLr",
    recordId: s.id,
    title: "Review the LR reading",
    sub: "Confirm the number against the receipt. Saving records it on the bill.",
    submit: "Save the LR",
    init: { lr: p.lrNo ?? "" },
    header: [{ k: "lr", l: "Despatch LR no", t: "text", req: true, conf: (p.lrConfidence as "high" | "check" | "not found") ?? "check" }],
    evidence: { images: [p.fileId], flags: p.flags, note: p.transporter ? `Transporter on the receipt: ${p.transporter}${p.date ? ` · dated ${p.date}` : ""}` : undefined },
  };
}

export async function applyLr(ctx: ErpContext, suggestionId: string, h: Record<string, string>): Promise<Result<unknown>> {
  const [s] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, suggestionId));
  if (!s || s.outcome !== "pending" || !s.recordId) return err("That reading has already been decided.", "conflict");
  const lr = text(h.lr);
  if (!lr) return fieldErr("lr", "LR number is required");
  const [dup] = await db.select({ orderNo: erpTransports.orderNo }).from(erpTransports).where(and(eq(erpTransports.lrNo, lr), ne(erpTransports.id, s.recordId)));
  if (dup) return fieldErr("lr", `LR ${lr} is already on order ${dup.orderNo}`);
  await db.update(erpTransports).set({ lrNo: lr, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(erpTransports.id, s.recordId));
  const p = s.proposed as unknown as LrProposal;
  await decideSuggestion(suggestionId, outcomeOf({ lr: p.lrNo }, { lr }), { lr });
  await erpAudit(ctx, "erp.ai.lr.apply", "erp_transport", s.recordId, null, { lr, suggestionId });
  return okVoid(`LR ${lr} recorded`);
}

/* =============================================================== tests */

const TestSchema = z.object({
  density: z.number().nullable().describe("the reading on the density meter or hydrometer"),
  densityConfidence: Conf,
  ph: z.number().nullable().describe("the reading on the pH meter or strip"),
  phConfidence: Conf,
  observation: z.string().nullable().describe("one short sentence on what the colour, paint or thermocol photos show — never a pass or fail"),
});
export type TestReading = z.infer<typeof TestSchema>;
type TestProposal = TestReading & { flags: { tone: Tone; text: string }[]; fileIds: string[] };

export async function readTestPhotos(ctx: ErpContext, testId: string): Promise<Result<unknown>> {
  const state = await featureState("photos", true);
  if (!state.on) return err(state.reason, "rule_violation");
  const [t] = await db.select().from(erpTests).where(eq(erpTests.id, testId));
  if (!t) return err("That test no longer exists.", "not_found");
  const fileIds = [t.densityPhotoId, t.phPhotoId, t.colorPhotoId, t.oilPhotoId, t.fastPhotoId, t.ncPhotoId, t.primerPhotoId, t.thermocolPhotoId].filter((x): x is string => !!x);
  if (!fileIds.length) return err("Upload the test photographs first, then read them.", "rule_violation");
  const read = await readImages({
    label: "ERP test photos",
    system: "You read quality-test photographs at a paint factory: a density meter or hydrometer, a pH meter or strip, and sample panels. Read the numbers exactly as shown; never estimate. For the panels write one neutral observation, never a pass or fail.",
    instruction: "Read the density and pH shown in these test photos, and describe the sample panels in one sentence.",
    schema: TestSchema,
    attachmentIds: fileIds,
  });
  if (!read.output) return err(read.error ?? "The photos could not be read. Enter the readings by hand.", "rule_violation");
  return recordTestReading(ctx, t, read.output, fileIds, read.model);
}

export async function recordTestReading(ctx: ErpContext, t: typeof erpTests.$inferSelect, r: TestReading, fileIds: string[], servedBy: string | null): Promise<Result<unknown>> {
  const flags: { tone: Tone; text: string }[] = [];
  const [m] = await db.select({ density: erpRawMaterials.density, name: erpRawMaterials.name }).from(erpRawMaterials).where(eq(erpRawMaterials.id, t.rawMaterialId));
  const tol = (await getConfig())["erp.ai.qc.densityTolerancePct"];
  if (r.density != null && m?.density && (Math.abs(r.density - m.density) / m.density) * 100 > tol)
    flags.push({ tone: "danger", text: `Density ${r.density} is more than ${tol}% from ${m.name}'s master density ${m.density}.` });
  if (r.density != null && (r.density < 0.5 || r.density > 1.5)) flags.push({ tone: "danger", text: `Density ${r.density} is outside 0.5–1.5; the form will refuse it.` });
  if (!flags.length && r.density != null) flags.push({ tone: "success", text: "The density is within tolerance of the master." });
  const proposal: TestProposal = { ...r, flags, fileIds };
  await logSuggestion({ feature: "photos", recordType: "erp_test", recordId: t.id, inputRef: fileIds.join(","), proposed: proposal as unknown as Record<string, unknown>, confidence: { density: r.densityConfidence, ph: r.phConfidence }, servedBy, userId: ctx.user.id });
  return okVoid(`Readings proposed${r.density != null ? ` · density ${r.density}` : ""}${r.ph != null ? ` · pH ${r.ph}` : ""}. Open "Review photo readings" to confirm.`);
}

/** The test's own evidence form, with the readings proposed and the photos beside them. */
export async function testReviewForm(base: FormSpec, testId: string): Promise<FormSpec | null> {
  const s = await pending(testId);
  if (!s) return null;
  const p = s.proposed as unknown as TestProposal;
  const conf = (c: string) => (c as "high" | "check" | "not found") ?? "check";
  return {
    ...base,
    id: "aiTest",
    recordId: s.id,
    title: "Review the photo readings",
    sub: "Readings proposed from the photos. Verification stays with the verifier.",
    init: {
      ...base.init,
      ...(p.density != null ? { density: String(p.density) } : {}),
      ...(p.ph != null ? { phValue: String(p.ph) } : {}),
      ...(p.observation ? { remark: [base.init?.remark, p.observation].filter(Boolean).join("\n") } : {}),
    },
    header: base.header.map((f) => (f.k === "density" ? { ...f, conf: conf(p.densityConfidence) } : f.k === "phValue" ? { ...f, conf: conf(p.phConfidence) } : f)),
    evidence: { images: p.fileIds, flags: p.flags },
  };
}

export async function decideTestReading(suggestionId: string, h: Record<string, string>) {
  const [s] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, suggestionId));
  if (!s || s.outcome !== "pending") return;
  const p = s.proposed as unknown as TestProposal;
  const final = { density: num(h.density), ph: num(h.phValue) };
  await decideSuggestion(suggestionId, outcomeOf({ density: p.density, ph: p.ph }, final), final);
}

export async function rejectPhotoReading(ctx: ErpContext, recordId: string): Promise<Result<unknown>> {
  const s = await pending(recordId);
  if (!s) return err("There is no reading to reject.", "not_found");
  await decideSuggestion(s.id, "rejected");
  await erpAudit(ctx, "erp.ai.photo.reject", String(s.recordType), recordId, null, { suggestionId: s.id });
  return okVoid("Reading rejected · nothing was changed");
}
