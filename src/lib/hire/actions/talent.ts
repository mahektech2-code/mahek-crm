"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { hireBlueprints, hireCandidates } from "@/db/schema";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap } from "../access";
import { hireTrail } from "../services/core";
import { createApplication } from "../services/pipeline";
import { candidateInScope, searchPool, type SearchFilters, type SearchResult } from "../services/talent";

/* ---------------------------------------------------------------------------
 * The talent pool's writes. Every one is a person deciding something about a
 * past candidate, so every one is on the audit trail with who and why.
 * ------------------------------------------------------------------------- */

const refuse = (e: unknown): Result<never> => (e instanceof HireNotPermitted ? err(e.message, "not_permitted") : fromThrown(e));

/** Search runs as an action so the page stays a server component around a client box. */
export async function runTalentSearch(query: string, filters: SearchFilters): Promise<Result<SearchResult>> {
  try {
    const ctx = await requireHireCap();
    const r = await searchPool(ctx, query.slice(0, 500), filters, Date.now());
    return ok(r);
  } catch (e) {
    return refuse(e);
  }
}

/**
 * Invite a past candidate to apply for an open role. A new application, under
 * the role's CURRENT published version, through the same door every
 * application uses — so the duplicate check, the cooling-off rule and the
 * linked history all apply. Consent is re-recorded: agreeing to be considered
 * last year is not agreeing now.
 */
export async function inviteToApply(input: { candidateId: string; blueprintKey: string; consent: boolean; note: string }): Promise<Result<{ applicationId: string }>> {
  try {
    const ctx = await requireHireCap("addCandidate");
    if (!input.consent) return { ok: false, error: "Record that the candidate agreed to be considered again — and was told AI assists evaluation.", code: "validation", fieldErrors: [{ field: "consent", message: "Required" }] };
    const c = await candidateInScope(ctx, input.candidateId);
    if (!c) return err("That candidate is not in your pool.", "not_found");
    if (c.do_not_contact) return err("This candidate asked not to be contacted.", "rule_violation");
    if (c.has_open) return err("They already have an open application.", "duplicate");
    const [bp] = await db
      .select({ id: hireBlueprints.id, title: hireBlueprints.title, version: hireBlueprints.version })
      .from(hireBlueprints)
      .where(and(eq(hireBlueprints.key, input.blueprintKey), eq(hireBlueprints.status, "published")))
      .limit(1);
    if (!bp) return err("That role has no published version to apply against.", "validation");
    const r = await createApplication(ctx, {
      fullName: String(c.full_name),
      phone: String(c.primary_phone),
      email: (c.email as string) ?? undefined,
      location: (c.location as string) ?? undefined,
      gender: (c.gender as string) ?? undefined,
      ageBand: (c.age_band as string) ?? undefined,
      preferredLanguage: (c.preferred_language as string) ?? undefined,
      source: "Talent pool",
      sourceDetail: input.note.trim() || "Invited from the talent pool",
      blueprintId: bp.id,
      consent: true,
      enteredVia: "talent_pool",
    });
    if (!r.ok) return r;
    await hireTrail(ctx, {
      applicationId: r.data.applicationId,
      candidateId: input.candidateId,
      entityType: "candidate",
      entityId: input.candidateId,
      event: "pool_invite",
      summary: `Invited from the talent pool to apply for ${bp.title} v${bp.version} · consent re-recorded${input.note.trim() ? ` · “${input.note.trim()}”` : ""}`,
    });
    revalidatePath("/hire/pool");
    return ok({ applicationId: r.data.applicationId }, `Invited — a new application for ${bp.title} is on the board.`);
  } catch (e) {
    return refuse(e);
  }
}

/** Mark (or unmark) a silver medallist — somebody strong worth bringing back. */
export async function setSilverMedallist(candidateId: string, on: boolean, reason: string): Promise<Result> {
  try {
    const ctx = await requireHireCap("addCandidate");
    if (reason.trim().length < 10) return { ok: false, error: "Say briefly why.", code: "validation", fieldErrors: [{ field: "reason", message: "At least 10 characters" }] };
    const c = await candidateInScope(ctx, candidateId);
    if (!c) return err("That candidate is not in your pool.", "not_found");
    await db.update(hireCandidates).set({ talentPoolStatus: on ? "silver_medallist" : "active", updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hireCandidates.id, candidateId));
    await hireTrail(ctx, { candidateId, entityType: "candidate", entityId: candidateId, event: on ? "silver_medallist" : "silver_medallist_removed", summary: `${on ? "Marked a silver medallist" : "No longer a silver medallist"} · “${reason.trim()}”`, before: { talentPoolStatus: c.talent_pool_status }, after: { talentPoolStatus: on ? "silver_medallist" : "active" } });
    revalidatePath("/hire/pool");
    return ok(undefined, on ? "Marked a silver medallist." : "Removed from silver medallists.");
  } catch (e) {
    return refuse(e);
  }
}

/** "Not for this role" — kept on the audit trail, which is where the pool reads it back from. */
export async function skipForRole(candidateId: string, blueprintKey: string, reason: string): Promise<Result> {
  try {
    const ctx = await requireHireCap("addCandidate");
    if (reason.trim().length < 10) return { ok: false, error: "Say briefly why.", code: "validation", fieldErrors: [{ field: "reason", message: "At least 10 characters" }] };
    const c = await candidateInScope(ctx, candidateId);
    if (!c) return err("That candidate is not in your pool.", "not_found");
    await hireTrail(ctx, { candidateId, entityType: "candidate", entityId: candidateId, event: "pool_skip", summary: `Not for ${blueprintKey} · “${reason.trim()}”`, after: { blueprintKey } });
    revalidatePath("/hire/pool");
    return ok(undefined, "Taken off this role’s list.");
  } catch (e) {
    return refuse(e);
  }
}
