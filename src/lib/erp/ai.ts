import "server-only";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { attachments, erpAiSuggestions } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { readSecret } from "@/lib/secrets";
import { fileStorage } from "@/lib/storage";
import { readStructured, structuredReadAvailable } from "@/lib/structured-read";
import { erpId } from "./server";
import { today } from "./screens/common";

/* ---------------------------------------------------------------------------
 * The ERP's AI plumbing (AI PRD §1): one place that decides whether a feature
 * may run — switched on, a provider key present, under its monthly cap — reads
 * images or text into a schema, and logs every suggestion with what the
 * person then did with it. Reading only: nothing here writes a record.
 * ------------------------------------------------------------------------- */

export type AiFeature = "bills" | "orders" | "ask" | "photos" | "complaints";

export type FeatureState = { on: true } | { on: false; reason: string };

const SWITCH: Record<AiFeature, "erp.ai.bills.enabled" | "erp.ai.orders.enabled" | "erp.ai.ask.enabled" | "erp.ai.photos.enabled" | "erp.ai.complaints.enabled"> = {
  bills: "erp.ai.bills.enabled",
  orders: "erp.ai.orders.enabled",
  ask: "erp.ai.ask.enabled",
  photos: "erp.ai.photos.enabled",
  complaints: "erp.ai.complaints.enabled",
};
const CAP: Record<AiFeature, "erp.ai.bills.monthlyCap" | "erp.ai.orders.monthlyCap" | "erp.ai.ask.monthlyCap" | "erp.ai.photos.monthlyCap" | "erp.ai.complaints.monthlyCap"> = {
  bills: "erp.ai.bills.monthlyCap",
  orders: "erp.ai.orders.monthlyCap",
  ask: "erp.ai.ask.monthlyCap",
  photos: "erp.ai.photos.monthlyCap",
  complaints: "erp.ai.complaints.monthlyCap",
};

/** Whether a feature may run now, and if not, the sentence that says why. */
export async function featureState(feature: AiFeature, needsVision = false): Promise<FeatureState> {
  const c = await getConfig();
  if (!c[SWITCH[feature]]) return { on: false, reason: "This AI feature is switched off in Settings." };
  const keyed = needsVision ? Boolean(await readSecret("openai.apiKey")) : await structuredReadAvailable();
  if (!keyed) return { on: false, reason: needsVision ? "Reading images needs an OpenAI key, set in Admin Console → Platform." : "No AI provider key is set in Admin Console → Platform." };
  const monthStart = new Date(`${today().slice(0, 7)}-01T00:00:00+05:30`);
  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(erpAiSuggestions)
    .where(and(eq(erpAiSuggestions.feature, feature), gte(erpAiSuggestions.createdAt, monthStart)))) as { n: number }[];
  if (Number(n) >= c[CAP[feature]]) return { on: false, reason: `This month's ${c[CAP[feature]]} readings are used; the feature is quiet until the 1st, or until the cap is raised in Settings.` };
  return { on: true };
}

/** Reads photographs or a PDF into a schema, with the configured vision model. */
export async function readImages<S extends z.ZodTypeAny>(args: { label: string; system: string; instruction: string; schema: S; attachmentIds: string[] }): Promise<{ output: z.infer<S> | null; model: string | null; error?: string }> {
  const key = await readSecret("openai.apiKey");
  if (!key) return { output: null, model: null, error: "No OpenAI key is set." };
  const files = await db.select().from(attachments).where(inArray(attachments.id, args.attachmentIds));
  if (!files.length) return { output: null, model: null, error: "The photograph could not be found." };
  const parts = await Promise.all(
    files.map(async (f) => ({ type: "file" as const, data: new Uint8Array(await fileStorage.read(f.storedRef)), mediaType: f.contentType })),
  );
  const model = (await getConfig())["erp.ai.visionModel"];
  try {
    const result = await generateObject({
      model: createOpenAI({ apiKey: key })(model),
      schema: args.schema,
      system: args.system,
      messages: [{ role: "user", content: [{ type: "text", text: args.instruction }, ...parts] }],
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(90_000),
    });
    return { output: result.object as z.infer<S>, model: `openai:${model}` };
  } catch (e) {
    console.error(`${args.label}: vision read failed:`, e instanceof Error ? e.message : e);
    return { output: null, model: null, error: "The model could not read this. Enter the values by hand." };
  }
}

/** Reads words into a schema: OpenAI first, Sarvam if it cannot answer. */
export async function readText<S extends z.ZodTypeAny>(args: { label: string; system: string; prompt: string; schema: S; shapeHint: string }) {
  const model = (await getConfig())["erp.ai.textModel"];
  return readStructured({ ...args, model });
}

/** Logs a suggestion before anybody decides on it. Returns its id. */
export async function logSuggestion(s: {
  feature: AiFeature;
  recordType?: string;
  recordId?: string | null;
  inputRef?: string | null;
  proposed: Record<string, unknown>;
  confidence?: Record<string, string>;
  servedBy?: string | null;
  /** Null for a scheduled reading nobody asked for by hand. */
  userId: string | null;
}): Promise<string> {
  const id = erpId("ais");
  await db.insert(erpAiSuggestions).values({
    id,
    feature: s.feature,
    recordType: s.recordType ?? null,
    recordId: s.recordId ?? null,
    inputRef: s.inputRef ?? null,
    proposed: s.proposed,
    confidence: s.confidence ?? {},
    servedBy: s.servedBy ?? null,
    userId: s.userId,
  });
  return id;
}

/** What the person did with it: accepted as proposed, edited, or rejected. */
export async function decideSuggestion(id: string, outcome: "accepted" | "edited" | "rejected", final?: Record<string, unknown>) {
  await db.update(erpAiSuggestions).set({ outcome, final: final ?? null, decidedAt: new Date() }).where(eq(erpAiSuggestions.id, id));
}

/** Accepted if every proposed value came back unchanged; edited otherwise. */
export function outcomeOf(proposed: Record<string, unknown>, final: Record<string, unknown>): "accepted" | "edited" {
  for (const k of Object.keys(proposed)) {
    const a = proposed[k] == null ? "" : String(proposed[k]);
    const b = final[k] == null ? "" : String(final[k]);
    if (a !== b) return "edited";
  }
  return "accepted";
}

/** The latest undecided suggestion of a feature for a record, if any. */
export async function pendingSuggestion(feature: AiFeature, recordId: string) {
  const [s] = await db
    .select()
    .from(erpAiSuggestions)
    .where(and(eq(erpAiSuggestions.feature, feature), eq(erpAiSuggestions.recordId, recordId), eq(erpAiSuggestions.outcome, "pending")))
    .orderBy(sql`${erpAiSuggestions.createdAt} desc`)
    .limit(1);
  return s ?? null;
}

/** Records with an undecided suggestion of a feature — for "review" actions on list rows. */
export async function pendingFor(feature: AiFeature): Promise<Set<string>> {
  const rows = await db.select({ id: erpAiSuggestions.recordId }).from(erpAiSuggestions).where(and(eq(erpAiSuggestions.feature, feature), eq(erpAiSuggestions.outcome, "pending")));
  return new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
}
