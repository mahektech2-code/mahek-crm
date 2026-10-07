import "server-only";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  hireApplications,
  hireAudit,
  hireBlueprints,
  hireBriefingResponses,
  hireCandidates,
  hireDecisions,
  hireDocuments,
  hireOffers,
  hireOnboardingItems,
  hireStageExecutions,
  type HireApplication,
  type HireBlueprint,
  type HireCandidate,
  type HireStageExecution,
} from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import type { BlueprintDefinition, Stage } from "../blueprint-types";
import { isScored, stageByKey } from "../blueprint-types";
import { canMove, OVERRIDE_REASON_MIN } from "../engines/gating";
import { scopeWhere, type HireContext } from "../access";
import { GATE_POINT } from "../roles";

/* ---------------------------------------------------------------------------
 * What every Hire service is built on: ids, the audit trail, the blueprint a
 * candidate is on, where they are, and the ONE way they move.
 * ------------------------------------------------------------------------- */

export const hid = (prefix: string) => `${prefix}_${randomUUID()}`;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

export type AuditInput = {
  applicationId?: string | null;
  candidateId?: string | null;
  entityType: string;
  entityId?: string | null;
  eventType: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  pii?: string[];
  aiTaskId?: string | null;
};

/** Append one line to the audit trail. `ctx` null means the system did it. */
export async function audit(ctx: Pick<HireContext, "user" | "roleLabel"> | null, a: AuditInput, x: Exec = db): Promise<void> {
  await x.insert(hireAudit).values({
    id: hid("hau"),
    applicationId: a.applicationId ?? null,
    candidateId: a.candidateId ?? null,
    entityType: a.entityType,
    entityId: a.entityId ?? null,
    eventType: a.eventType,
    summary: a.summary,
    actorId: ctx?.user.id ?? null,
    actorName: ctx?.user.name ?? "System",
    actorRole: ctx?.roleLabel ?? null,
    before: (a.before ?? null) as never,
    after: (a.after ?? null) as never,
    isPiiAccess: Boolean(a.pii?.length),
    piiFields: a.pii ?? [],
    aiTaskId: a.aiTaskId ?? null,
  });
}

export const loadBlueprint = cache(async (id: string): Promise<HireBlueprint | null> => {
  const [b] = await db.select().from(hireBlueprints).where(eq(hireBlueprints.id, id)).limit(1);
  return b ?? null;
});

export type AppBundle = { app: HireApplication; candidate: HireCandidate; blueprint: HireBlueprint; def: BlueprintDefinition; stage: Stage | null };

/** One application, IF this person may see it. Null is "not found" either way. */
export async function getApplication(ctx: HireContext, id: string): Promise<AppBundle | null> {
  const rows = await db
    .select({ app: hireApplications, candidate: hireCandidates })
    .from(hireApplications)
    .innerJoin(hireCandidates, eq(hireCandidates.id, hireApplications.candidateId))
    .where(and(eq(hireApplications.id, id), sql`${scopeWhere(ctx, "hire_applications")}`))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const blueprint = await loadBlueprint(r.app.blueprintId);
  if (!blueprint) return null;
  const def = blueprint.definition;
  return { app: r.app, candidate: r.candidate, blueprint, def, stage: stageByKey(def, r.app.stageKey) ?? null };
}

/** The live execution of a stage (the newest that nothing superseded), if any. */
export async function currentExecution(applicationId: string, stageKey: string, x: Exec = db): Promise<HireStageExecution | null> {
  const [e] = await x
    .select()
    .from(hireStageExecutions)
    .where(and(eq(hireStageExecutions.applicationId, applicationId), eq(hireStageExecutions.stageKey, stageKey), isNull(hireStageExecutions.supersededById)))
    .orderBy(desc(hireStageExecutions.createdAt))
    .limit(1);
  return e ?? null;
}

/** The execution for a stage, created if this is the first time anybody touched it. */
export async function ensureExecution(applicationId: string, stage: Stage, actorId: string | null, x: Exec = db): Promise<HireStageExecution> {
  const cur = await currentExecution(applicationId, stage.key, x);
  if (cur) return cur;
  const [row] = await x
    .insert(hireStageExecutions)
    .values({
      id: hid("hex"),
      applicationId,
      stageKey: stage.key,
      status: "not_started",
      maxPoints: isScored(stage) ? stage.maxPoints : null,
      outcome: "pending",
      createdById: actorId,
    })
    .returning();
  return row;
}

export type Outcome = { outcome: "pass" | "fail" | "pending"; why?: string };

/**
 * Whether the CURRENT stage is passed, read off the records behind it. Scored
 * stages carry their outcome on the execution (set by the scoring service);
 * every other kind is derived from its own rows, so a document verified or a
 * topic ticked moves the answer without anybody remembering to.
 */
export async function stageOutcome(app: HireApplication, def: BlueprintDefinition): Promise<Outcome> {
  const stage = stageByKey(def, app.stageKey);
  if (!stage) return { outcome: "pending", why: "This stage is no longer in the blueprint." };
  const exec = await currentExecution(app.id, stage.key);

  if (isScored(stage)) {
    if (!exec || exec.outcome === "pending") return { outcome: "pending", why: `${stage.name} has not been scored and confirmed yet.` };
    if (exec.outcome === "fail") return { outcome: "fail", why: `Scored ${exec.finalScore} at ${stage.name} against a pass mark of ${stage.passThreshold}.` };
    return { outcome: "pass" };
  }
  switch (stage.type) {
    case "application": {
      if (app.duplicate?.status === "open") return { outcome: "pending", why: "A possible duplicate needs a human decision first." };
      return exec?.outcome === "pass" ? { outcome: "pass" } : { outcome: "pending", why: "The application has not been reviewed yet." };
    }
    case "decision_gate": {
      const [d] = await db
        .select({ decision: hireDecisions.decision })
        .from(hireDecisions)
        .where(and(eq(hireDecisions.applicationId, app.id), eq(hireDecisions.decisionPoint, GATE_POINT), isNull(hireDecisions.supersededById)))
        .orderBy(desc(hireDecisions.decidedAt))
        .limit(1);
      return d?.decision === "advance" ? { outcome: "pass" } : { outcome: "pending", why: "The decision gate has no recorded decision to advance." };
    }
    case "briefing": {
      if (!exec) return { outcome: "pending", why: "The briefing has not been held yet." };
      const resp = await db.select().from(hireBriefingResponses).where(and(eq(hireBriefingResponses.executionId, exec.id), isNull(hireBriefingResponses.supersededById)));
      const by = new Map(resp.map((r) => [r.pointKey, r.response]));
      const points = stage.briefing ?? [];
      const missing = points.filter((p) => !by.has(p.key));
      if (missing.length) return { outcome: "pending", why: `${missing.length} briefing point${missing.length === 1 ? " has" : "s have"} no response yet.` };
      const blocked = points.filter((p) => p.blocking && by.get(p.key) === "disagree");
      if (blocked.length) return { outcome: "fail", why: `Disagreed with ${blocked.map((p) => p.title).join(", ")} — a blocking briefing point.` };
      return { outcome: "pass" };
    }
    case "document_collection": {
      const docs = await db.select().from(hireDocuments).where(and(eq(hireDocuments.applicationId, app.id), isNull(hireDocuments.supersededById)));
      const okKeys = new Set(docs.filter((d) => d.verificationStatus === "verified" || d.verificationStatus === "waived").map((d) => d.requirementKey));
      const missing = def.documents.filter((d) => d.mandatory && !okKeys.has(d.key));
      if (missing.length) return { outcome: "pending", why: `Mandatory documents missing or unverified: ${missing.map((d) => d.label).join(", ")}.` };
      const [offer] = await db.select({ status: hireOffers.status, courier: hireOffers.courierStatus }).from(hireOffers).where(and(eq(hireOffers.applicationId, app.id), isNull(hireOffers.supersededById))).orderBy(desc(hireOffers.createdAt)).limit(1);
      if (offer?.status !== "accepted") return { outcome: "pending", why: offer ? `The offer is ${offer.status}, not accepted.` : "No offer has been issued yet." };
      /* Courier status gates progression (spec §7.1): the signed letter is back with us. */
      if (offer.courier !== "received" && offer.courier !== "received_by_staff") return { outcome: "pending", why: "The signed offer letter has not come back by courier yet." };
      return { outcome: "pass" };
    }
    case "checklist":
    case "system_setup": {
      const kinds = stage.type === "checklist" ? ["asset", "topic"] : ["setup"];
      const items = await db.select().from(hireOnboardingItems).where(and(eq(hireOnboardingItems.applicationId, app.id), inArray(hireOnboardingItems.kind, kinds)));
      const done = new Set(items.filter((i) => i.done).map((i) => `${i.kind}:${i.groupKey}:${i.itemKey}`));
      const need =
        stage.type === "checklist"
          ? [...def.onboarding.assets.map((a) => `asset:assets:${a.key}`), ...def.onboarding.modules.flatMap((m) => m.topics.map((t) => `topic:${m.key}:${t.key}`))]
          : def.onboarding.setup.flatMap((g) => g.steps.map((s) => `setup:${g.key}:${s.key}`));
      const left = need.filter((k) => !done.has(k)).length;
      if (left) return { outcome: "pending", why: stage.type === "checklist" ? `${left} asset${left === 1 ? "" : "s"} or training topic${left === 1 ? "" : "s"} still open — a module is complete only when every topic is ticked.` : `${left} setup step${left === 1 ? "" : "s"} still open.` };
      return { outcome: "pass" };
    }
    default:
      return exec?.outcome === "pass" ? { outcome: "pass" } : { outcome: "pending", why: `${stage.name} is not complete.` };
  }
}

/**
 * THE one way a candidate moves stage (spec §6.1). The entry rule is checked
 * here, on the server; an override needs the capability and a reason, writes
 * an audit line and leaves a marker on the record.
 */
export async function moveApplication(ctx: HireContext, applicationId: string, targetKey: string, overrideReason?: string): Promise<Result<{ stageKey: string }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const oc = await stageOutcome(b.app, b.def);
  const verdict = canMove(b.def, { status: b.app.status, stageKey: b.app.stageKey, currentOutcome: oc.outcome, pendingWhy: oc.why }, targetKey);
  const target = stageByKey(b.def, targetKey);
  if (!target) return err("That stage is not in this candidate’s blueprint.", "validation");
  let overridden = false;
  if (!verdict.ok) {
    if (!verdict.overridable || overrideReason == null) return err(verdict.why, "rule_violation");
    if (!ctx.can("override")) return err("A gate override needs a Hiring Manager, HR Head or Admin.", "not_permitted");
    if (overrideReason.trim().length < OVERRIDE_REASON_MIN) return { ok: false, error: `An override reason of at least ${OVERRIDE_REASON_MIN} characters is required.`, code: "validation", fieldErrors: [{ field: "reason", message: "Too short" }] };
    overridden = true;
  }
  const from = b.stage?.name ?? b.app.stageKey;
  await db.transaction(async (tx) => {
    await tx
      .update(hireApplications)
      .set({
        stageKey: target.key,
        stageEnteredAt: new Date(),
        updatedAt: new Date(),
        updatedById: ctx.user.id,
        ...(overridden ? { override: { by: ctx.user.id, byName: ctx.user.name, reason: overrideReason!.trim(), at: new Date().toISOString(), into: target.name } } : {}),
      })
      .where(eq(hireApplications.id, applicationId));
    const exec = await ensureExecution(applicationId, target, ctx.user.id, tx);
    if (overridden) await tx.update(hireStageExecutions).set({ entryWasGated: false, gateOverrideById: ctx.user.id, gateOverrideReason: overrideReason!.trim() }).where(eq(hireStageExecutions.id, exec.id));
    await audit(
      ctx,
      {
        applicationId,
        candidateId: b.candidate.id,
        entityType: "application",
        entityId: applicationId,
        eventType: overridden ? "gate_override" : "stage_move",
        summary: overridden ? `Gate override: ${from} → ${target.name} · “${overrideReason!.trim()}”` : `Moved ${from} → ${target.name} · entry rule passed`,
        before: { stageKey: b.app.stageKey },
        after: { stageKey: target.key },
      },
      tx,
    );
  });
  return ok({ stageKey: target.key }, overridden ? `Moved with an override — marked on ${b.candidate.fullName}’s record.` : `${b.candidate.fullName} moved to ${target.name}.`);
}

/** Advance to the next stage if the current one is passed; used after a stage completes. */
export async function advanceIfPassed(ctx: HireContext, applicationId: string): Promise<boolean> {
  const b = await getApplication(ctx, applicationId);
  if (!b || b.app.status !== "in_progress") return false;
  const i = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
  const next = b.def.stages[i + 1];
  if (!next) return false;
  const oc = await stageOutcome(b.app, b.def);
  if (oc.outcome !== "pass" || b.stage?.type === "decision_gate") return false;
  const r = await moveApplication(ctx, applicationId, next.key);
  return r.ok;
}

export const hoursSince = (d: Date | string | null | undefined, now = Date.now()) => (d ? Math.max(0, (now - new Date(d).getTime()) / 3_600_000) : 0);

/**
 * Record a message on the candidate's Communication tab. Every channel lands
 * here — a WhatsApp or SMS a person sent from their own phone is `logged`
 * once they confirm it went, exactly as the CRM treats a copied message.
 */
export async function recordMessage(
  ctx: Pick<HireContext, "user" | "roleLabel"> | null,
  m: { candidateId: string; applicationId?: string | null; direction: "out" | "in"; channel: "whatsapp" | "sms" | "email" | "portal" | "phone"; language?: string; subject?: string | null; body: string; aiDrafted?: boolean; aiTaskId?: string | null; status?: string },
): Promise<string> {
  const { hireMessages } = await import("@/db/schema");
  const msgId = hid("hms");
  await db.insert(hireMessages).values({
    id: msgId,
    candidateId: m.candidateId,
    applicationId: m.applicationId ?? null,
    direction: m.direction,
    channel: m.channel,
    language: m.language ?? "English",
    subject: m.subject ?? null,
    body: m.body,
    aiDrafted: Boolean(m.aiDrafted),
    aiTaskId: m.aiTaskId ?? null,
    status: m.status ?? "sent",
    sentById: m.direction === "out" ? (ctx?.user.id ?? null) : null,
  });
  await audit(ctx, { applicationId: m.applicationId, candidateId: m.candidateId, entityType: "message", entityId: msgId, eventType: m.direction === "out" ? "message_sent" : "message_received", summary: `${m.direction === "out" ? "Sent" : "Received"} ${m.channel} (${m.language ?? "English"})${m.aiDrafted ? " · AI-drafted, reviewed by a person" : ""}` });
  return msgId;
}
