import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { erpAiSuggestions, erpRequests } from "@/db/schema";
import { err, fieldErr, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { decideSuggestion, featureState, logSuggestion, outcomeOf, readText } from "./ai";
import { refValues } from "./refs";
import { erpAudit, text } from "./server";
import type { FormSpec } from "./ui";

/* ---------------------------------------------------------------------------
 * AI-6's reading half: from a request's own description, a suggested
 * complaint type (one of the reference list, never a new one) and a one-line
 * summary, which the person confirms or changes. It never proposes a credit
 * note amount; the trace and cluster notice beside it are rules.
 * ------------------------------------------------------------------------- */

export async function suggestComplaint(ctx: ErpContext, requestId: string): Promise<Result<unknown>> {
  const state = await featureState("complaints");
  if (!state.on) return err(state.reason, "rule_violation");
  const [r] = await db.select().from(erpRequests).where(eq(erpRequests.id, requestId));
  if (!r) return err("That request no longer exists.", "not_found");
  if (!r.description) return err("The request has no description to read.", "rule_violation");
  const types = await refValues("complaintType");
  const read = await readText({
    label: "ERP complaint",
    system: `You classify complaints from paint customers. Choose the complaint type ONLY from this list: ${types.join(", ")}. If none fits, answer null. Then write a one-line English summary of what the customer says, without adding causes or blame.`,
    prompt: r.description,
    schema: z.object({ type: z.string().nullable(), typeConfidence: z.enum(["high", "check", "not found"]), summary: z.string().nullable() }),
    shapeHint: '{"type": string|null, "typeConfidence": "high"|"check"|"not found", "summary": string|null}',
  });
  if (!read.output) return err("The description could not be read.", "rule_violation");
  const type = read.output.type && types.includes(read.output.type) ? read.output.type : null;
  await logSuggestion({ feature: "complaints", recordType: "erp_request", recordId: requestId, inputRef: "description", proposed: { type, summary: read.output.summary }, confidence: { type: type ? read.output.typeConfidence : "not found" }, servedBy: read.model, userId: ctx.user.id });
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
  const [r] = await db.select().from(erpRequests).where(eq(erpRequests.id, requestId));
  const p = s.proposed as { type: string | null; summary: string | null };
  return {
    screen,
    id: "aiComplaint",
    recordId: s.id,
    title: "Review the complaint suggestion",
    sub: "Suggested from the description. Confirm or change it.",
    submit: "Confirm",
    init: { type: p.type ?? r?.complaintType ?? "", summary: p.summary ?? "" },
    header: [
      { k: "type", l: "Complaint type", t: "select", req: true, opts: await refValues("complaintType"), conf: (s.confidence.type as "high" | "check" | "not found") ?? "check" },
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
  await db.update(erpRequests).set({ complaintType: type, updatedAt: new Date() }).where(eq(erpRequests.id, s.recordId));
  const final = { type, summary: text(h.summary) };
  await decideSuggestion(suggestionId, outcomeOf(s.proposed as Record<string, unknown>, final), final);
  await erpAudit(ctx, "erp.ai.complaint.apply", "erp_request", s.recordId, null, final);
  return okVoid(`Complaint type ${type} confirmed`);
}

export async function rejectComplaint(ctx: ErpContext, requestId: string): Promise<Result<unknown>> {
  const s = await pending(requestId);
  if (!s) return err("There is no suggestion to reject.", "not_found");
  await decideSuggestion(s.id, "rejected");
  await erpAudit(ctx, "erp.ai.complaint.reject", "erp_request", requestId, null, { suggestionId: s.id });
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
