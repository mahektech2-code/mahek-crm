import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { attachments, erpAiSuggestions, erpTransporters } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { featureState, logSuggestion, outcomeOf, readImages } from "./ai";
import { cleanLrReading, styleLine, type LrStyle, type LrSuggestion } from "./engines/lr-read";
import { today } from "./screens/common";

/* ---------------------------------------------------------------------------
 * Upload LRs: a photo or PDF in, the row's fields filled for the person to
 * check. The model (OpenAI, `erp.ai.visionModel`, behind `erp.ai.photos` and
 * its monthly cap) is told every transporter on the desk with what it calls
 * its consignment number and what its earlier numbers looked like, because a
 * receipt carries half a dozen numbers and the transporter's own STYLE is what
 * picks the right one. `engines/lr-read.ts` checks what came back. Nothing is
 * written but the suggestion row; the upload is still the person's.
 * ------------------------------------------------------------------------- */

/** Earlier numbers per transporter, for its style. */
const EXAMPLES_PER_TRANSPORTER = 5;

export async function lrStyles(): Promise<LrStyle[]> {
  const [dir, recent] = await Promise.all([
    db.select({ name: erpTransporters.name, label: erpTransporters.consignmentLabel }).from(erpTransporters).where(eq(erpTransporters.active, true)),
    db.execute(sql`
      select transporter, lr_no as "lrNo" from (
        select transporter, lr_no, row_number() over (partition by lower(transporter) order by uploaded_at desc) as n
        from erp_lrs
        where status <> 'void' and transporter is not null and lr_no is not null
      ) x where n <= ${EXAMPLES_PER_TRANSPORTER}
    `) as unknown as Promise<{ transporter: string; lrNo: string }[]>,
  ]);
  const by = new Map<string, string[]>();
  for (const r of recent) by.set(r.transporter.toLowerCase(), [...(by.get(r.transporter.toLowerCase()) ?? []), r.lrNo]);
  return dir.map((t) => ({ name: t.name, label: t.label, examples: by.get(t.name.toLowerCase()) ?? [] }));
}

const ReadingSchema = z.object({
  lrNo: z.string().nullable().describe("The consignment number exactly as printed, without its label. Null if none is printed."),
  lrLabelSeen: z.string().nullable().describe('The words printed beside that number, e.g. "G.R. No.", "LR No", "Consignment Note No".'),
  transporter: z.string().nullable().describe("The transport company that issued the receipt — from its letterhead. Use the directory's spelling where it is one of them."),
  lrDate: z.string().nullable().describe("The receipt's date as YYYY-MM-DD. Indian receipts write dates day first: 09/10/26 is 2026-10-09."),
  destination: z.string().nullable().describe("The destination / to station printed on the receipt, in English letters."),
  packages: z.number().nullable().describe("The number of articles / packages / boxes."),
  freightTerm: z.string().nullable().describe('How freight is paid as printed: "Paid", "To Pay" or "TBB" (to be billed).'),
  freightRupees: z.number().nullable().describe("The total freight in rupees, if printed."),
  confidence: z.enum(["high", "check"]).describe('"high" only if the number is printed clearly and you are sure which number it is.'),
});

function systemFor(styles: LrStyle[]): string {
  const directory = styles.length ? styles.map(styleLine).join("\n") : "(none recorded yet)";
  return `You read Indian lorry receipts — LR, GR, G.C. note, consignment note, bilty, docket — photographed by a paint company's dispatch team. Transcribe only what is printed; never guess or invent. A field that is not printed is null.

The consignment number is the one the transport company gives this consignment. It is NOT a phone number, a GSTIN (15 characters ending in Z and one more), a PAN, a pin code, our invoice or e-way bill number, a vehicle number, or a seal number. Transport companies label it differently, and each company keeps its own style of number.

The transporters this company uses, how each one labels its consignment number, and what its earlier numbers looked like:
${directory}

First decide which transporter issued the receipt from its letterhead. Then read the number printed under that transporter's label, and expect it to look like its earlier numbers. If it is handwritten or smudged, or you cannot tell which number it is, answer it with confidence "check".`;
}

export type LrReadAnswer = { readingId: string; suggestion: LrSuggestion };

/** Reads a just-uploaded LR file. Only the uploader's own unfiled file may be read. */
export async function readUploadedLr(ctx: ErpContext, fileId: string): Promise<Result<LrReadAnswer>> {
  const state = await featureState("photos", true);
  if (!state.on) return err(state.reason, "rule_violation");
  const [file] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.id, fileId), eq(attachments.uploadedById, ctx.actor.id), eq(attachments.status, "available"), isNull(attachments.parentId)));
  if (!file) return err("That file is not one you just uploaded.", "not_found");
  const styles = await lrStyles();
  const read = await readImages({
    label: "ERP LR upload",
    system: systemFor(styles),
    instruction: "Read this lorry receipt.",
    schema: ReadingSchema,
    attachmentIds: [fileId],
  });
  if (!read.output) return err(read.error ?? "The receipt could not be read. Type the details from the photo.", "rule_violation");
  const suggestion = cleanLrReading(read.output, styles, today());
  const readingId = await logSuggestion({
    feature: "photos",
    recordType: "erp_lr",
    inputRef: fileId,
    proposed: { ...suggestion, raw: read.output } as unknown as Record<string, unknown>,
    confidence: { lrNo: suggestion.checkNumber ? "check" : "high" },
    servedBy: read.model,
    userId: ctx.actor.id,
  });
  return ok({ readingId, suggestion });
}

/** The fields a reading proposed, in the shape the upload saves them. */
const COMPARED = ["lrNo", "lrDate", "transporter", "destination", "packages", "freightTerm", "freightRupees"] as const;

/**
 * Once the LRs are uploaded, each reading is marked accepted or edited against
 * what was actually saved, and pointed at the LR it became. A reading for a
 * row that was removed stays pending, which is the truth: nobody used it.
 */
export async function settleLrReadings(ctx: ErpContext, saved: { readingId: string; lrId: string; final: Record<string, unknown> }[]): Promise<void> {
  if (!saved.length) return;
  const rows = await db
    .select()
    .from(erpAiSuggestions)
    .where(and(inArray(erpAiSuggestions.id, saved.map((s) => s.readingId)), eq(erpAiSuggestions.feature, "photos"), eq(erpAiSuggestions.recordType, "erp_lr"), eq(erpAiSuggestions.userId, ctx.actor.id), eq(erpAiSuggestions.outcome, "pending"), isNull(erpAiSuggestions.recordId)));
  for (const r of rows) {
    const s = saved.find((x) => x.readingId === r.id)!;
    const proposed = Object.fromEntries(COMPARED.map((k) => [k, r.proposed[k] ?? null]));
    const final = Object.fromEntries(COMPARED.map((k) => [k, s.final[k] ?? null]));
    await db
      .update(erpAiSuggestions)
      .set({ outcome: outcomeOf(proposed, final), final, recordId: s.lrId, decidedAt: new Date() })
      .where(and(eq(erpAiSuggestions.id, r.id), eq(erpAiSuggestions.outcome, "pending")));
  }
}

/** Whether the Upload LRs modal should offer to read photos at all. */
export async function lrReadingOn(): Promise<boolean> {
  return (await featureState("photos", true)).on;
}
