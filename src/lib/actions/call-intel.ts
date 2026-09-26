"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { MAX_CALL_TEXT } from "@/lib/call-intel-labels";
import { db } from "@/db";
import { customers } from "@/db/schema";
import {
  assertCustomerInScope,
  canFor,
  resolveScope,
} from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import type { LeadSalesType, LeadStage } from "@/lib/lead-labels";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import {
  analyseCall,
  markDraftApplied,
  noteDraftEnglish,
  type AnalyseResult,
} from "@/lib/services/call-intel-service";

/* ---------------------------------------------------------------------------
 * The call assistant's two doors from the browser.
 *
 * `analyseCallAction` READS. It writes one row — the transcript and the
 * proposal, in `call_ai_drafts` — and nothing a telecaller would call a
 * record: no call, no reminder, no complaint. Everything it proposes reaches
 * the ledger only through the ordinary save, pressed by a person.
 *
 * Text rather than audio, so it is a server action rather than a route: the
 * audio has already been through `/api/dictate/transcribe` and been dropped.
 * ------------------------------------------------------------------------- */

const analyseSchema = z.object({
  customerId: z.string().min(1),
  spoken: z.string().max(MAX_CALL_TEXT).default(""),
  english: z.string().max(MAX_CALL_TEXT).default(""),
  typedNote: z.string().max(MAX_CALL_TEXT).default(""),
  language: z.string().max(20).nullable().default(null),
  /* `dictation`: spoken, read before the provider that heard it reported in. */
  heardBy: z.enum(["sarvam", "openai", "dictation", "typed"]).default("typed"),
  interactionType: z
    .enum(["outbound_call", "inbound_call"])
    .nullable()
    .default(null),
  /** The English was changed by hand after it was heard; it wins. */
  edited: z.boolean().default(false),
});

export async function analyseCallAction(
  raw: z.input<typeof analyseSchema>,
): Promise<Result<AnalyseResult>> {
  try {
    const parsed = analyseSchema.safeParse(raw);
    if (!parsed.success) return err("That could not be read.", "validation");
    return await analyseCall(parsed.data);
  } catch (e) {
    return fromThrown(e);
  }
}

export async function markSuggestionAppliedAction(
  draftId: string,
  outcome: string,
): Promise<Result<null>> {
  try {
    return await markDraftApplied(
      String(draftId),
      String(outcome).slice(0, 40),
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/** The note the telecaller used, onto the reading that described it. */
export async function noteDraftEnglishAction(
  draftId: string,
  english: string,
  heardBy: "sarvam" | "openai" | null,
): Promise<Result<null>> {
  try {
    return await noteDraftEnglish(
      String(draftId),
      String(english).slice(0, MAX_CALL_TEXT),
      heardBy === "sarvam" || heardBy === "openai" ? heardBy : null,
    );
  } catch (e) {
    return fromThrown(e);
  }
}

/** Whether to draw the assistant at all. Switched off is drawn as nothing. */
export async function callAssistantStatus(): Promise<{ enabled: boolean }> {
  try {
    const config = await getConfig();
    return { enabled: Boolean(config["callIntel.enabled"]) };
  } catch {
    return { enabled: false };
  }
}

export type SampleRequestContext = {
  leadStage: LeadStage | null;
  salesType: LeadSalesType | null;
  reasons: Array<{ code: string; label: string }>;
  canWork: boolean;
};

/**
 * What the sample form needs to be the SAME form the lead record opens — the
 * rung, the ladder, the configured reasons and whether this person may ask.
 * Read on demand, because most calls never raise a sample.
 */
export async function sampleRequestContext(
  customerId: string,
): Promise<Result<SampleRequestContext>> {
  try {
    const ctx = await resolveScope();
    const [row] = await db
      .select({
        kind: customers.kind,
        ownerId: customers.ownerId,
        salesAmId: customers.salesAmId,
        backOfficeAmId: customers.backOfficeAmId,
        leadManagerId: customers.leadManagerId,
        relationshipOwnerId: customers.relationshipOwnerId,
        leadStage: customers.leadStage,
        salesType: customers.leadSalesType,
      })
      .from(customers)
      .where(eq(customers.id, String(customerId)));
    if (!row) return err("That customer no longer exists.", "not_found");
    await assertCustomerInScope(row);
    const config = await getConfig();
    return ok({
      leadStage: (row.leadStage as LeadStage | null) ?? null,
      salesType: (row.salesType as LeadSalesType | null) ?? null,
      reasons: config["leads.sampleReasons"],
      canWork: await canFor(ctx.user, "lead.work"),
    });
  } catch (e) {
    return fromThrown(e);
  }
}
