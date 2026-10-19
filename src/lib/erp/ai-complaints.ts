import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { complaints, erpAiSuggestions } from "@/db/schema";
import { ERP_COMPLAINT_CATEGORY } from "./screens/complaints";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { decideSuggestion, featureState, logSuggestion, outcomeOf, readText } from "./ai";
import { erpAudit, text } from "./server";
import type { FormSpec } from "./ui";

/* ---------------------------------------------------------------------------
 * AI-6's reading half: from a complaint's own description, a one-line
 * summary, which the person confirms or changes. It never proposes a credit
 * note amount; the trace and cluster notice beside it are rules. It no longer
 * suggests a TYPE: the ERP handles product quality complaints only, so a type
 * changed here would only take the complaint off the ERP's own list. The type
 * is the CRM's to change.
 * ------------------------------------------------------------------------- */

export async function suggestComplaint(ctx: ErpContext, requestId: string): Promise<Result<unknown>> {
  const state = await featureState("complaints");
  if (!state.on) return err(state.reason, "rule_violation");
  const [r] = await db.select().from(complaints).where(eq(complaints.id, requestId));
  if (!r || r.category !== ERP_COMPLAINT_CATEGORY) return err("That complaint no longer exists.", "not_found");
  if (!r.description) return err("The complaint has no description to read.", "rule_violation");
  const read = await readText({
    label: "ERP complaint",
    system: "You read product quality complaints from paint customers. Write a one-line English summary of what the customer says, without adding causes or blame.",
    prompt: r.description,
    schema: z.object({ summary: z.string().nullable() }),
    shapeHint: '{"summary": string|null}',
  });
  if (!read.output?.summary) return err("The description could not be read.", "rule_violation");
  await logSuggestion({ feature: "complaints", recordType: "complaint", recordId: requestId, inputRef: "description", proposed: { summary: read.output.summary }, confidence: { summary: "check" }, servedBy: read.model, userId: ctx.user.id });
  return okVoid('Summary suggested. Open "Review the suggestion" to confirm.');
}

async function pending(requestId: string) {
  const [s] = await db
    .select()
    .from(erpAiSuggestions)
    .where(and(eq(erpAiSuggestions.feature, "complaints"), eq(erpAiSuggestions.recordId, requestId), eq(erpAiSuggestions.outcome, "pending")))
    .orderBy(desc(erpAiSuggestions.createdAt))
    .limit(1);
  return s ?? null;
}

export async function complaintReviewForm(screen: string, requestId: string): Promise<FormSpec | null> {
  const s = await pending(requestId);
  if (!s) return null;
  const [r] = await db.select().from(complaints).where(eq(complaints.id, requestId));
  const p = s.proposed as { summary: string | null };
  return {
    screen,
    id: "aiComplaint",
    recordId: s.id,
    title: "Review the complaint suggestion",
    sub: "A summary suggested from the description. Confirm or change it.",
    submit: "Confirm",
    init: { summary: p.summary ?? "" },
    header: [{ k: "summary", l: "Summary", t: "text", req: true, conf: "check" }],
    evidence: { text: r?.description ?? "" },
  };
}

export async function applyComplaint(ctx: ErpContext, suggestionId: string, h: Record<string, string>): Promise<Result<unknown>> {
  const [s] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, suggestionId));
  if (!s || s.outcome !== "pending" || !s.recordId) return err("That suggestion has already been decided.", "conflict");
  const summary = text(h.summary);
  if (!summary) return fieldErr("summary", "Summary is required");
  const final = { summary };
  await decideSuggestion(suggestionId, outcomeOf(s.proposed as Record<string, unknown>, final), final);
  await erpAudit(ctx, "erp.ai.complaint.apply", "complaint", s.recordId, null, final);
  return okVoid("Summary confirmed");
}

export async function rejectComplaint(ctx: ErpContext, requestId: string): Promise<Result<unknown>> {
  const s = await pending(requestId);
  if (!s) return err("There is no suggestion to reject.", "not_found");
  await decideSuggestion(s.id, "rejected");
  await erpAudit(ctx, "erp.ai.complaint.reject", "complaint", requestId, null, { suggestionId: s.id });
  return okVoid("Suggestion rejected");
}

/** Confirmed summaries, for the request record. */
export async function confirmedSummaries(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: erpAiSuggestions.recordId, final: erpAiSuggestions.final, at: erpAiSuggestions.decidedAt })
    .from(erpAiSuggestions)
    .where(and(eq(erpAiSuggestions.feature, "complaints"), inArray(erpAiSuggestions.recordId, ids), inArray(erpAiSuggestions.outcome, ["accepted", "edited"])))
    .orderBy(desc(erpAiSuggestions.decidedAt));
  const out = new Map<string, string>();
  for (const r of rows) {
    const summary = (r.final as { summary?: string | null } | null)?.summary;
    if (r.id && summary && !out.has(r.id)) out.set(r.id, summary);
  }
  return out;
}
