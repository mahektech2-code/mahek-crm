"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { hireAiOutputs, hireApplications, hireCandidates, hireDecisions, hireFiles, hireProfiles, type HireProfileData } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { sendMail } from "@/lib/mailer";
import { err, fieldErr, ok, type Result } from "@/lib/result";
import { fileStorage } from "@/lib/storage";
import { isScored, stageByKey } from "../blueprint-types";
import { HireNotPermitted, requireHireCap, seesScores, type HireContext } from "../access";
import { hireTrail, ensureExecution, getApplication, hid, recordMessage } from "../services/core";
import { candidateSources } from "../services/candidate";
import { resolveDuplicate, screenIn } from "../services/pipeline";
import { summariseCandidate } from "../ai/summary";
import { checkConsistency } from "../ai/consistency";
import { parseCv, PROFILE_FIELDS } from "../ai/parse-cv";
import { draftMessage as draftWithAi, type Purpose } from "../ai/draft-message";
import { fdt } from "@/app/hire/_ui/kit";

/* ---------------------------------------------------------------------------
 * Every write the candidate record makes. Each checks for itself — a server
 * action is a URL — then reads the application through `getApplication`, so an
 * id outside the caller's scope is "not found", never a write.
 * ------------------------------------------------------------------------- */

const REASON_MIN = 20;
const path = (id: string) => `/hire/c/${id}`;

async function guard<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    console.error("hire candidate action:", e);
    return err(e instanceof Error ? e.message : "Something went wrong.");
  }
}

async function load(ctx: HireContext, applicationId: string) {
  const b = await getApplication(ctx, applicationId);
  if (!b) throw new HireNotPermitted("That candidate is not on your list.");
  return b;
}

const canWorkPipeline = (ctx: HireContext) => ctx.can("addCandidate") || ctx.can("decide");

/* -------------------------------------------------------------- the header */

export async function resolveDuplicateAction(applicationId: string, same: boolean, reason: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!canWorkPipeline(ctx)) return err("Deciding a duplicate needs a Recruiter, Hiring Manager, HR Head or Admin.", "not_permitted");
    await load(ctx, applicationId);
    const r = await resolveDuplicate(ctx, applicationId, same, reason);
    revalidatePath(path(applicationId));
    return r;
  });
}

export async function screenInAction(applicationId: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!canWorkPipeline(ctx)) return err("Screening in needs a Recruiter, Hiring Manager, HR Head or Admin.", "not_permitted");
    await load(ctx, applicationId);
    const r = await screenIn(ctx, applicationId);
    revalidatePath(path(applicationId));
    return r;
  });
}

/** Hold, resume or withdraw: a decision with its reasoning, never a silent status flip. */
export async function changeStatus(applicationId: string, to: "hold" | "resume" | "withdraw", reasoning: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!canWorkPipeline(ctx)) return err("This needs a Recruiter, Hiring Manager, HR Head or Admin.", "not_permitted");
    const b = await load(ctx, applicationId);
    if (reasoning.trim().length < REASON_MIN) return fieldErr("reasoning", `At least ${REASON_MIN} characters — it is kept on the record.`);
    const from = b.app.status;
    if (to === "hold" && from !== "in_progress") return err("Only an application in progress can be put on hold.", "rule_violation");
    if (to === "resume" && from !== "on_hold") return err("Only an application on hold can be resumed.", "rule_violation");
    if (to === "withdraw" && from !== "in_progress" && from !== "on_hold") return err("This application is already closed.", "rule_violation");
    const status = to === "hold" ? "on_hold" : to === "resume" ? "in_progress" : "withdrawn";
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(hireDecisions).values({
        id: hid("hde"),
        applicationId,
        decisionPoint: "status",
        decidedById: ctx.user.id,
        decidedByRole: ctx.roleLabel,
        decision: to,
        reasoning: reasoning.trim(),
      });
      await tx
        .update(hireApplications)
        .set({
          status,
          holdReason: to === "hold" ? reasoning.trim() : to === "resume" ? null : b.app.holdReason,
          closedAt: to === "withdraw" ? now : b.app.closedAt,
          updatedAt: now,
          updatedById: ctx.user.id,
        })
        .where(eq(hireApplications.id, applicationId));
      await hireTrail(
        ctx,
        {
          applicationId,
          candidateId: b.candidate.id,
          entityType: "application",
          entityId: applicationId,
          event: `status_${to}`,
          summary: `${to === "hold" ? "Put on hold" : to === "resume" ? "Resumed" : "Withdrawn"} · “${reasoning.trim()}”`,
          before: { status: from },
          after: { status },
        },
        tx,
      );
    });
    revalidatePath(path(applicationId));
    return ok(undefined, to === "hold" ? "On hold — the reason is on the record." : to === "resume" ? "Resumed." : "Withdrawn.");
  });
}

/** Open (creating if need be) the current stage's execution, for the interview workspace. */
export async function openCurrentInterview(applicationId: string): Promise<Result<{ href: string }>> {
  return guard(async () => {
    const ctx = await requireHireCap("interview");
    const b = await load(ctx, applicationId);
    if (!b.stage || !isScored(b.stage)) return err("The current stage is not an interview.", "rule_violation");
    if (b.app.status !== "in_progress") return err(`The application is ${b.app.status.replace("_", " ")}.`, "rule_violation");
    const ex = await ensureExecution(applicationId, b.stage, ctx.user.id);
    return ok({ href: `/hire/workspace/${ex.id}` });
  });
}

/* ------------------------------------------------------------- AI: summary */

export async function generateSummary(applicationId: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!seesScores(ctx)) return err("An interviewer does not see the case across stages.", "not_permitted");
    const b = await load(ctx, applicationId);
    const sources = await candidateSources(applicationId, b.def);
    if (!sources.length) return err("There is nothing the candidate has said yet to summarise.", "rule_violation");
    const execs = (await db.execute(
      sql`select stage_key, final_score from hire_stage_executions where application_id = ${applicationId} and superseded_by_id is null and final_score is not null`,
    )) as unknown as { stage_key: string; final_score: number }[];
    const res = await summariseCandidate({
      roleTitle: b.blueprint.title,
      def: b.def,
      stageScores: execs.map((e) => {
        const st = stageByKey(b.def, e.stage_key);
        return { stage: st?.name ?? e.stage_key, score: Math.round(Number(e.final_score)), pass: st?.passThreshold ?? 70 };
      }),
      sources: sources.map((s) => ({ label: s.label, text: s.text, question: s.question })),
      actorId: ctx.user.id,
      applicationId,
      blueprintId: b.blueprint.id,
    });
    if (!res.ok) return err(`${res.reason} The summary was not changed.`, "rule_violation");
    const now = new Date();
    await db.insert(hireAiOutputs).values({ id: hid("hao"), kind: "summary", applicationId, blueprintId: b.blueprint.id, content: res.output, aiTaskId: res.taskId, createdById: ctx.user.id });
    await db
      .update(hireApplications)
      .set({ aiRecommendation: { action: res.output.recommendation.action, confidence: res.output.recommendation.confidence, why: res.output.recommendation.why, taskId: res.taskId, at: now.toISOString() } })
      .where(eq(hireApplications.id, applicationId));
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "ai_output", event: "summary_generated", summary: `AI summary generated · recommendation: ${res.output.recommendation.action} (${res.output.recommendation.confidence})`, aiTaskId: res.taskId });
    revalidatePath(path(applicationId));
    return ok(undefined, "Summary updated.");
  });
}

/* --------------------------------------------------------- AI: consistency */

function profileText(p: HireProfileData | null): string {
  if (!p) return "";
  const f = Object.entries(p.fields).map(([k, v]) => `${k}: ${v.value}`);
  const e = p.employers.map((x) => `${x.name} · ${x.title} · ${x.from} – ${x.to}${x.months != null ? ` (${x.months} months)` : ""}`);
  return [...f, ...e].join("\n");
}

export async function runConsistencyCheck(applicationId: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!seesScores(ctx)) return err("Run by the recruiter or hiring manager.", "not_permitted");
    const b = await load(ctx, applicationId);
    const [prof] = await db.select().from(hireProfiles).where(eq(hireProfiles.applicationId, applicationId)).limit(1);
    const answers = await candidateSources(applicationId, b.def);
    const sources = [...(prof ? [{ label: "CV", text: profileText(prof.data) }] : []), ...answers.map((a) => ({ label: a.label, text: a.text }))];
    if (sources.length < 2) return err("Consistency needs at least two sources — the CV and an interview, or two interviews.", "rule_violation");
    const res = await checkConsistency({ sources, actorId: ctx.user.id, applicationId, blueprintId: b.blueprint.id });
    if (!res.ok) {
      /* Degradation (spec §4.3): skipped, and the record says it was not performed. */
      const [prior] = await db.select({ id: hireAiOutputs.id }).from(hireAiOutputs).where(and(eq(hireAiOutputs.applicationId, applicationId), eq(hireAiOutputs.kind, "consistency"))).limit(1);
      if (!prior) await db.insert(hireAiOutputs).values({ id: hid("hao"), kind: "consistency", applicationId, blueprintId: b.blueprint.id, content: { skipped: true, reason: res.reason }, aiTaskId: res.taskId, createdById: ctx.user.id });
      await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "ai_output", event: "consistency_skipped", summary: `Consistency check not performed — ${res.reason}`, aiTaskId: res.taskId });
      revalidatePath(path(applicationId));
      return err(`${res.reason} The check was not performed, and the record says so.`, "rule_violation");
    }
    await db.insert(hireAiOutputs).values({ id: hid("hao"), kind: "consistency", applicationId, blueprintId: b.blueprint.id, content: res.output, aiTaskId: res.taskId, createdById: ctx.user.id });
    const n = res.output.inconsistencies.length;
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "ai_output", event: "consistency_checked", summary: `Consistency check: ${n ? `${n} item${n === 1 ? "" : "s"} to ask about` : "nothing to ask about"}`, aiTaskId: res.taskId });
    revalidatePath(path(applicationId));
    return ok(undefined, n ? `${n} thing${n === 1 ? "" : "s"} worth asking about.` : "Nothing contradicts.");
  });
}

/* ------------------------------------------------------------------ profile */

const canEditProfile = (ctx: HireContext) => ctx.can("addCandidate") || ctx.can("documents") || ctx.can("decide");

const CV_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"]);
const MAX_CV = 8 * 1024 * 1024;

export async function uploadCv(applicationId: string, form: FormData): Promise<Result<{ fileId: string }>> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!canEditProfile(ctx)) return err("Uploading a CV needs a Recruiter, Hiring Manager, Onboarding, HR Head or Admin.", "not_permitted");
    const b = await load(ctx, applicationId);
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return fieldErr("file", "Choose a file.");
    if (file.size > MAX_CV) return fieldErr("file", "A CV is at most 8 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniff(bytes) ?? (file.type === "text/plain" ? "text/plain" : null);
    if (!type || !CV_TYPES.has(type)) return fieldErr("file", "A PDF, a photograph (JPEG, PNG, WebP) or a text file.");
    const fileId = hid("hfl");
    const stored = await fileStorage.upload({ key: `hire/cv/${b.candidate.id}/${fileId}`, body: bytes, contentType: type });
    await db.insert(hireFiles).values({ id: fileId, candidateId: b.candidate.id, applicationId, purpose: "cv", filename: file.name.slice(0, 200), contentType: type, sizeBytes: stored.sizeBytes, storedRef: stored.ref, uploadedById: ctx.user.id });
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "file", entityId: fileId, event: "cv_uploaded", summary: `CV uploaded · ${file.name}` });
    revalidatePath(path(applicationId));
    return ok({ fileId }, "CV uploaded.");
  });
}

function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export async function parseCvAction(applicationId: string, fileId: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!canEditProfile(ctx)) return err("Not on your account.", "not_permitted");
    const b = await load(ctx, applicationId);
    const [f] = await db.select().from(hireFiles).where(and(eq(hireFiles.id, fileId), eq(hireFiles.candidateId, b.candidate.id), isNull(hireFiles.removedAt))).limit(1);
    if (!f) return err("That CV is not on this candidate.", "not_found");
    const bytes = new Uint8Array(await fileStorage.read(f.storedRef));
    let text: string | undefined;
    let file: { bytes: Uint8Array; mediaType: string } | undefined;
    if (f.contentType === "text/plain") text = new TextDecoder().decode(bytes);
    else if (f.contentType === "application/pdf") {
      try {
        const { extractText, getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(bytes);
        const r = await extractText(pdf, { mergePages: true });
        text = Array.isArray(r.text) ? r.text.join("\n") : r.text;
      } catch {
        text = undefined;
      }
      if (!text || text.replace(/\s/g, "").length < 80) {
        text = undefined;
        file = { bytes, mediaType: f.contentType };
      }
    } else file = { bytes, mediaType: f.contentType };
    const res = await parseCv({ roleTitle: b.blueprint.title, text, file, actorId: ctx.user.id, applicationId, blueprintId: b.blueprint.id });
    if (!res.ok) return err(`${res.reason} Enter the profile by hand below.`, "rule_violation");
    const [prior] = await db.select().from(hireProfiles).where(eq(hireProfiles.applicationId, applicationId)).limit(1);
    const data = res.output.data;
    if (prior) {
      /* A person's correction outlives a re-parse. */
      for (const [k, v] of Object.entries(prior.data.fields)) if (v.source === "human") data.fields[k] = v;
      await db.update(hireProfiles).set({ data, sourceFileId: f.id, extractionConfidence: res.output.confidence, extractedAt: new Date(), aiTaskId: res.taskId, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hireProfiles.applicationId, applicationId));
    } else {
      await db.insert(hireProfiles).values({ applicationId, data, sourceFileId: f.id, extractionConfidence: res.output.confidence, extractedAt: new Date(), aiTaskId: res.taskId, createdById: ctx.user.id });
    }
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "profile", entityId: applicationId, event: "cv_parsed", summary: `CV parsed by AI · ${f.filename} · overall confidence ${Math.round(res.output.confidence * 100)}% — low-confidence fields are marked for review`, aiTaskId: res.taskId });
    revalidatePath(path(applicationId));
    return ok(undefined, "Parsed. Check the amber fields.");
  });
}

/** A person corrects one field. The old value is kept in `corrections`; nothing is overwritten silently. */
export async function correctProfileField(applicationId: string, field: string, value: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap();
    if (!canEditProfile(ctx)) return err("Not on your account.", "not_permitted");
    const b = await load(ctx, applicationId);
    const v = value.trim();
    if (!v) return fieldErr("value", "Enter a value.");
    if (!PROFILE_FIELDS.includes(field)) return err("Not a profile field.", "validation");
    const [prior] = await db.select().from(hireProfiles).where(eq(hireProfiles.applicationId, applicationId)).limit(1);
    const at = new Date().toISOString();
    if (!prior) {
      const data: HireProfileData = { fields: { [field]: { value: v, source: "human", confidence: 1 } }, employers: [], education: [], skills: [], languages: [], gaps: [] };
      await db.insert(hireProfiles).values({ applicationId, data, corrections: [{ field, from: "—", to: v, byId: ctx.user.id, byName: ctx.user.name, at }], createdById: ctx.user.id });
    } else {
      const old = prior.data.fields[field]?.value ?? "—";
      if (old === v) return ok(undefined, "Unchanged.");
      const data = { ...prior.data, fields: { ...prior.data.fields, [field]: { value: v, source: "human" as const, confidence: 1 } } };
      await db
        .update(hireProfiles)
        .set({ data, corrections: [...(prior.corrections ?? []), { field, from: old, to: v, byId: ctx.user.id, byName: ctx.user.name, at }], updatedAt: new Date(), updatedById: ctx.user.id })
        .where(eq(hireProfiles.applicationId, applicationId));
    }
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "profile", entityId: applicationId, event: "profile_corrected", summary: `Corrected ${field} → ${v}` });
    revalidatePath(path(applicationId));
    return ok(undefined, `${field} saved.`);
  });
}

/* ------------------------------------------------------------ communication */

export type DraftResult = { subject: string; body: string; ai: boolean; notice: string | null; taskId: string | null };

export async function draftMessageAction(applicationId: string, input: { purpose: Purpose; channel: "whatsapp" | "sms" | "email"; language: string; note: string }): Promise<Result<DraftResult>> {
  return guard(async () => {
    const ctx = await requireHireCap("message");
    const b = await load(ctx, applicationId);
    const langs = (await getConfig())["hire.languages"].split(",").map((s) => s.trim());
    if (!langs.includes(input.language)) return fieldErr("language", "Not one of the configured languages.");
    const ex = b.stage ? await db.execute(sql`select scheduled_at, place from hire_stage_executions where application_id = ${applicationId} and stage_key = ${b.app.stageKey} and superseded_by_id is null order by created_at desc limit 1`) : [];
    const cur = (ex as unknown as { scheduled_at: string | null; place: string | null }[])[0];
    const docsNeeded = b.def.documents.filter((d) => d.mandatory).map((d) => d.label);
    const res = await draftWithAi({
      purpose: input.purpose,
      channel: input.channel,
      language: input.language,
      facts: {
        firstName: (b.candidate.preferredName ?? b.candidate.fullName).split(" ")[0],
        roleTitle: b.blueprint.title,
        stageName: b.stage?.name ?? "interview",
        nextAt: cur?.scheduled_at ? fdt(cur.scheduled_at) : null,
        place: cur?.place ?? b.app.location ?? null,
        docsNeeded: input.purpose === "documents" ? docsNeeded : [],
        senderName: ctx.user.name,
        note: input.note.trim(),
      },
      actorId: ctx.user.id,
      applicationId,
      blueprintId: b.blueprint.id,
    });
    return ok(res);
  });
}

async function guardContact(ctx: HireContext, applicationId: string) {
  const b = await load(ctx, applicationId);
  if (b.candidate.doNotContact) throw new HireNotPermitted(`Do not contact: ${b.candidate.dncReason ?? "the candidate asked not to be contacted"}.`);
  return b;
}

export async function sendEmail(applicationId: string, input: { subject: string; body: string; language: string; aiDrafted: boolean; aiTaskId: string | null }): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap("message");
    const b = await guardContact(ctx, applicationId);
    if (!b.candidate.email) return err("There is no email address on this candidate.", "validation");
    if (!input.subject.trim()) return fieldErr("subject", "A subject is required.");
    if (input.body.trim().length < 5) return fieldErr("body", "Write the message.");
    const r = await sendMail({ to: b.candidate.email, subject: input.subject.trim(), text: input.body.trim() });
    const status = r.delivered ? "sent" : r.reason === "not_configured" ? "not_sent" : "failed";
    await recordMessage(ctx, { candidateId: b.candidate.id, applicationId, direction: "out", channel: "email", language: input.language, subject: input.subject.trim(), body: input.body.trim(), aiDrafted: input.aiDrafted, aiTaskId: input.aiTaskId, status });
    revalidatePath(path(applicationId));
    if (!r.delivered)
      return r.reason === "not_configured"
        ? ok(undefined, "No mail provider is set — the email was written to the server log, not sent, and the record says so.")
        : err(`The mail provider refused it: ${r.detail}`, "rule_violation");
    return ok(undefined, "Email sent.");
  });
}

/** A WhatsApp or SMS sent from somebody's own phone is recorded only once they confirm it went. */
export async function confirmSentFromPhone(applicationId: string, input: { channel: "whatsapp" | "sms"; body: string; language: string; aiDrafted: boolean; aiTaskId: string | null }): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap("message");
    const b = await guardContact(ctx, applicationId);
    if (input.body.trim().length < 2) return fieldErr("body", "Write the message.");
    await recordMessage(ctx, { candidateId: b.candidate.id, applicationId, direction: "out", channel: input.channel, language: input.language, body: input.body.trim(), aiDrafted: input.aiDrafted, aiTaskId: input.aiTaskId, status: "logged" });
    revalidatePath(path(applicationId));
    return ok(undefined, "Recorded as sent.");
  });
}

export async function logReply(applicationId: string, input: { channel: "whatsapp" | "sms" | "email" | "phone"; body: string; language: string }): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap("message");
    const b = await load(ctx, applicationId);
    if (input.body.trim().length < 2) return fieldErr("body", "Write what they said.");
    await recordMessage(ctx, { candidateId: b.candidate.id, applicationId, direction: "in", channel: input.channel, language: input.language, body: input.body.trim(), status: "logged" });
    revalidatePath(path(applicationId));
    return ok(undefined, "Reply logged.");
  });
}

/** Mark do-not-contact (or lift it). Respected by every composer and search. */
export async function setDoNotContact(applicationId: string, on: boolean, reason: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap("message");
    const b = await load(ctx, applicationId);
    if (on && reason.trim().length < 10) return fieldErr("reason", "Say why, briefly.");
    await db.update(hireCandidates).set({ doNotContact: on, dncReason: on ? reason.trim() : null, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hireCandidates.id, b.candidate.id));
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "candidate", entityId: b.candidate.id, event: on ? "dnc_on" : "dnc_off", summary: on ? `Marked do not contact · “${reason.trim()}”` : "Do-not-contact lifted" });
    revalidatePath(path(applicationId));
    return ok(undefined, on ? "Marked do not contact." : "Contact allowed again.");
  });
}
