import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { complaints, erpAiSuggestions } from "@/db/schema";
import { categoryLabel, categoryValue } from "@/lib/complaint-labels";
import { getConfig } from "@/lib/config/store";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { decideSuggestion, featureState, logSuggestion, outcomeOf, readText } from "./ai";
import { erpAudit, text } from "./server";
import type { FormSpec } from "./ui";

/* ---------------------------------------------------------------------------
 * AI-6's reading half: from a complaint's own description, a suggested
 * category (one of the CRM's complaint categories, never a new one) and a
 * one-line summary, which the person confirms or changes. It never proposes a
 * credit note amount; the trace and cluster notice beside it are rules. The
 * complaint is the CRM's own record, so a confirmed category is the one the
 * telecaller sees too.
 * ------------------------------------------------------------------------- */

export async function suggestComplaint(ctx: ErpContext, requestId: string): Promise<Result<unknown>> {
  const state = await featureState("complaints");
  if (!state.on) return err(state.reason, "rule_violation");
  const [r] = await db.select().from(complaints).where(eq(complaints.id, requestId));
  if (!r) return err("That complaint no longer exists.", "not_found");
  if (!r.description) return err("The complaint has no description to read.", "rule_violation");
  const types = (await getConfig())["complaints.categories"];
  const read = await readText({
    label: "ERP complaint",
    system: `You classify complaints from paint customers. Choose the complaint type ONLY from this list: ${types.join(", ")}. If none fits, answer null. Then write a one-line English summary of what the customer says, without adding causes or blame.`,
    prompt: r.description,
    schema: z.object({ type: z.string().nullable(), typeConfidence: z.enum(["high", "check", "not found"]), summary: z.string().nullable() }),
    shapeHint: '{"type": string|null, "typeConfidence": "high"|"check"|"not found", "summary": string|null}',
  });
  if (!read.output) return err("The description could not be read.", "rule_violation");
  const type = read.output.type && types.includes(read.output.type) ? read.output.type : null;
  await logSuggestion({ feature: "complaints", recordType: "complaint", recordId: requestId, inputRef: "description", proposed: { type, summary: read.output.summary }, confidence: { type: type ? read.output.typeConfidence : "not found" }, servedBy: read.model, userId: ctx.user.id });
  return okVoid(`Suggested ${type ?? "no type from the list"}. Open "Review the suggestion" to confirm.`);
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
  const p = s.proposed as { type: string | null; summary: string | null };
  return {
    screen,
    id: "aiComplaint",
    recordId: s.id,
    title: "Review the complaint suggestion",
    sub: "Suggested from the description. Confirm or change it.",
    submit: "Confirm",
    init: { type: p.type ?? (r ? categoryLabel(r.category) : ""), summary: p.summary ?? "" },
    header: [
      { k: "type", l: "Complaint type", t: "select", req: true, opts: (await getConfig())["complaints.categories"], conf: (s.confidence.type as "high" | "check" | "not found") ?? "check" },
      { k: "summary", l: "Summary", t: "text", conf: "check" },
    ],
    evidence: { text: r?.description ?? "" },
  };
}

export async function applyComplaint(ctx: ErpContext, suggestionId: string, h: Record<string, string>): Promise<Result<unknown>> {
  const [s] = await db.select().from(erpAiSuggestions).where(eq(erpAiSuggestions.id, suggestionId));
  if (!s || s.outcome !== "pending" || !s.recordId) return err("That suggestion has already been decided.", "conflict");
  const type = text(h.type);
  if (!type) return fieldErr("type", "Complaint type is required");
  await db.update(complaints).set({ category: categoryValue(type) as never, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(complaints.id, s.recordId));
  const final = { type, summary: text(h.summary) };
  await decideSuggestion(suggestionId, outcomeOf(s.proposed as Record<string, unknown>, final), final);
  await erpAudit(ctx, "erp.ai.complaint.apply", "complaint", s.recordId, null, final);
  return okVoid(`Complaint type ${type} confirmed`);
}

export async function rejectComplaint(ctx: ErpContext, requestId: string): Promise<Result<unknown>> {
  const s = await pending(requestId);
  if (!s) return err("There is no suggestion to reject.", "not_found");
  await decideSuggestion(s.id, "rejected");
  await erpAudit(ctx, "erp.ai.complaint.reject", "complaint", requestId, null, { suggestionId: s.id });
  return okVoid("Suggestion rejected");
}

/** Confirmed summaries, for the request drawer. */
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
