import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  hireApplications,
  hireAssetIssues,
  hireBackgroundChecks,
  hireCourierEvents,
  hireCourierShipments,
  hireDocTemplates,
  hireDocuments,
  hireEmploymentDocs,
  hireFiles,
  hireIncentivePlans,
  users,
  type HireAssetIssue,
  type HireBackgroundCheck,
  type HireDocTemplate,
  type HireIncentivePlan,
  type HireIncentiveSlab,
} from "@/db/schema";
export { slabLines };
import { err, ok, type Result } from "@/lib/result";
import { calendarDate } from "@/lib/business-date";
import { fileStorage } from "@/lib/storage";
import { rupees, slabLines } from "@/app/hire/_onboard/letter";
import type { HireContext } from "../access";
import { isOnboardingFlow, stageByKey, type BlueprintDefinition } from "../blueprint-types";
import { COURIER_FLOW, COURIER_STATUSES, COURIER_STATUS_LABEL, EMP_DOC_LABEL, fillTemplate, unknownPlaceholders, type CourierStatus } from "../engines/onboarding";
import { advanceIfPassed, getApplication, hid, hireTrail, liveAssets, recordMessage, type AppBundle } from "./core";
import { currentOffer, letterFor } from "./offers";
import { refreshStage, sniff } from "./onboarding";
import { reveal, storeSecret, vaultAvailable } from "./vault";

/* ---------------------------------------------------------------------------
 * THE ONBOARDING PRD'S RECORDS: incentive plans, the background check,
 * employment documents and their templates, courier shipments, and company
 * assets. Each write is checked, audited, and then lets the stage it belongs
 * to re-read itself (`refreshStage`) and move on if it passed.
 * ------------------------------------------------------------------------- */

const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const validYmd = (s: string | null | undefined) => (s && YMD.test(s) ? s : null);

async function settle(ctx: HireContext, b: AppBundle) {
  await refreshStage(ctx, b);
  await advanceIfPassed(ctx, b.app.id);
}

/* ======================================================== incentive plans */

export async function listIncentivePlans(): Promise<{ key: string; versions: HireIncentivePlan[]; published: HireIncentivePlan | null; draft: HireIncentivePlan | null; offers: number }[]> {
  const rows = await db.select().from(hireIncentivePlans).orderBy(asc(hireIncentivePlans.key), desc(hireIncentivePlans.version));
  const counts = (await db.execute(sql`
    select p.key, count(o.id)::int as n from hire_offers o join hire_incentive_plans p on p.id = o.incentive_plan_id
     where o.status = 'accepted' group by p.key`)) as unknown as { key: string; n: number }[];
  const keys = [...new Set(rows.map((r) => r.key))];
  return keys.map((key) => {
    const v = rows.filter((r) => r.key === key);
    return { key, versions: v, published: v.find((x) => x.status === "published") ?? null, draft: v.find((x) => x.status === "draft") ?? null, offers: counts.find((c) => c.key === key)?.n ?? 0 };
  });
}

export async function publishedPlans(keys?: string[]): Promise<HireIncentivePlan[]> {
  return db
    .select()
    .from(hireIncentivePlans)
    .where(and(eq(hireIncentivePlans.status, "published"), keys ? (keys.length ? inArray(hireIncentivePlans.key, keys) : sql`false`) : sql`true`))
    .orderBy(asc(hireIncentivePlans.title));
}

export async function planById(id: string | null | undefined): Promise<HireIncentivePlan | null> {
  if (!id) return null;
  const [p] = await db.select().from(hireIncentivePlans).where(eq(hireIncentivePlans.id, id)).limit(1);
  return p ?? null;
}

export type PlanInput = { title: string; designations: string[]; basis: string; mode: "whole" | "marginal"; slabs: HireIncentiveSlab[]; conditions: string; effectiveFrom: string | null };

function cleanSlabs(slabs: HireIncentiveSlab[]): Result<HireIncentiveSlab[]> {
  const out = slabs
    .map((s) => ({ fromPaise: Math.max(0, Math.round(Number(s.fromPaise) || 0)), toPaise: s.toPaise == null || (s.toPaise as unknown) === "" ? null : Math.round(Number(s.toPaise)), kind: s.kind === "fixed" ? ("fixed" as const) : ("percent" as const), value: Math.max(0, Number(s.value) || 0) }))
    .sort((a, b) => a.fromPaise - b.fromPaise);
  if (!out.length) return err("A plan needs at least one slab.", "validation");
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s.toPaise != null && s.toPaise <= s.fromPaise) return err(`The slab from ${rupees(s.fromPaise)} ends before it starts.`, "validation");
    if (i > 0 && out[i - 1].toPaise !== s.fromPaise) return err(`The slabs leave a gap or overlap at ${rupees(s.fromPaise)} — each must start where the one before ends.`, "validation");
    if (s.kind === "percent" && s.value > 100) return err("A percentage slab is at most 100%.", "validation");
    if (i < out.length - 1 && s.toPaise == null) return err("Only the last slab may be open-ended.", "validation");
  }
  return ok(out);
}

export async function savePlanDraft(ctx: HireContext, key: string, input: PlanInput): Promise<Result<{ id: string; version: number }>> {
  const k = key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(k)) return { ok: false, error: "A plan key is lower-case letters, digits and dashes.", code: "validation", fieldErrors: [{ field: "key", message: "Letters, digits, dashes" }] };
  if (!input.title.trim()) return { ok: false, error: "Give the plan a title.", code: "validation", fieldErrors: [{ field: "title", message: "Required" }] };
  const slabs = cleanSlabs(input.slabs);
  if (!slabs.ok) return slabs;
  const values = {
    title: input.title.trim(),
    designations: [...new Set(input.designations.map((d) => d.trim()).filter(Boolean))],
    basis: input.basis.trim(),
    mode: input.mode === "marginal" ? "marginal" : "whole",
    slabs: slabs.data,
    conditions: input.conditions.trim(),
    effectiveFrom: validYmd(input.effectiveFrom),
    updatedAt: new Date(),
    updatedById: ctx.user.id,
  };
  const vs = await db.select().from(hireIncentivePlans).where(eq(hireIncentivePlans.key, k)).orderBy(desc(hireIncentivePlans.version));
  const draft = vs.find((v) => v.status === "draft");
  if (draft) {
    await db.update(hireIncentivePlans).set(values).where(eq(hireIncentivePlans.id, draft.id));
    return ok({ id: draft.id, version: draft.version }, `Draft v${draft.version} saved.`);
  }
  const id = hid("hip");
  const version = (vs[0]?.version ?? 0) + 1;
  await db.insert(hireIncentivePlans).values({ id, key: k, version, status: "draft", ...values, createdById: ctx.user.id });
  return ok({ id, version }, `Draft v${version} saved.`);
}

export async function publishPlan(ctx: HireContext, key: string): Promise<Result<{ version: number }>> {
  const [d] = await db.select().from(hireIncentivePlans).where(and(eq(hireIncentivePlans.key, key), eq(hireIncentivePlans.status, "draft"))).limit(1);
  if (!d) return err("There is no draft of this plan to publish.", "rule_violation");
  const check = cleanSlabs(d.slabs);
  if (!check.ok) return check;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(hireIncentivePlans).set({ status: "retired", updatedAt: now }).where(and(eq(hireIncentivePlans.key, key), eq(hireIncentivePlans.status, "published")));
    await tx.update(hireIncentivePlans).set({ status: "published", publishedAt: now, publishedById: ctx.user.id, updatedAt: now }).where(eq(hireIncentivePlans.id, d.id));
    await hireTrail(ctx, { entityType: "incentive_plan", entityId: d.id, event: "incentive_plan_published", summary: `Incentive plan “${d.title}” v${d.version} published · ${d.slabs.length} slabs`, after: { slabs: d.slabs } }, tx);
  });
  return ok({ version: d.version }, `v${d.version} published. Offers already made stay on the version they were made under.`);
}

/* ====================================================== background check */

export const BGV_STATUSES = ["not_started", "in_progress", "clear", "concern", "not_applicable"] as const;
export const BGV_LABEL: Record<string, string> = { not_started: "Not started", in_progress: "In progress", clear: "Clear", concern: "Concern", not_applicable: "Not applicable" };

export async function currentBgv(applicationId: string): Promise<HireBackgroundCheck | null> {
  const [r] = await db.select().from(hireBackgroundChecks).where(and(eq(hireBackgroundChecks.applicationId, applicationId), isNull(hireBackgroundChecks.supersededById))).orderBy(desc(hireBackgroundChecks.createdAt)).limit(1);
  return r ?? null;
}

export type BgvInput = { required: boolean; status: string; method?: string | null; vendor?: string | null; initiatedOn?: string | null; completedOn?: string | null };

export async function saveBgv(ctx: HireContext, applicationId: string, input: BgvInput): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  if (!["in_progress", "on_hold"].includes(b.app.status)) return err(`The application is ${b.app.status.replace("_", " ")}.`, "rule_violation");
  if (!(BGV_STATUSES as readonly string[]).includes(input.status)) return err("Pick a status.", "validation");
  const status = input.required ? input.status : "not_applicable";
  if (input.required && status === "not_applicable") return err("A required check is not “not applicable” — set Required to No instead.", "validation");
  const completedOn = validYmd(input.completedOn);
  if ((status === "clear" || status === "concern") && !completedOn) return { ok: false, error: "Say when the check was completed.", code: "validation", fieldErrors: [{ field: "completedOn", message: "Required" }] };
  const cur = await currentBgv(applicationId);
  const id = hid("hbg");
  const now = new Date();
  const values = { required: input.required, status, method: input.method?.trim() || null, vendor: input.vendor?.trim() || null, initiatedOn: validYmd(input.initiatedOn), completedOn };
  await db.transaction(async (tx) => {
    await tx.insert(hireBackgroundChecks).values({ id, applicationId, ...values, checkedById: ctx.user.id, remarkVaultIds: cur?.remarkVaultIds ?? [], createdById: ctx.user.id });
    if (cur) await tx.update(hireBackgroundChecks).set({ supersededById: id, updatedAt: now }).where(eq(hireBackgroundChecks.id, cur.id));
    await hireTrail(
      ctx,
      {
        applicationId,
        candidateId: b.candidate.id,
        entityType: "background_check",
        entityId: id,
        event: "background_check_saved",
        summary: `Background check: ${input.required ? BGV_LABEL[status] : "not required"}${values.method ? ` · ${values.method}` : ""}${values.vendor ? ` · ${values.vendor}` : ""}`,
        before: cur ? { required: cur.required, status: cur.status, method: cur.method, vendor: cur.vendor } : null,
        after: values,
      },
      tx,
    );
  });
  await settle(ctx, b);
  return ok(undefined, "Background check saved.");
}

export async function addBgvRemark(ctx: HireContext, applicationId: string, text: string): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const t = text.trim();
  if (t.length < 10) return { ok: false, error: "Write the remark in a sentence.", code: "validation", fieldErrors: [{ field: "remark", message: "Too short" }] };
  if (!vaultAvailable()) return err("This deployment has no app signing secret, so a restricted remark cannot be stored.", "rule_violation");
  const cur = await currentBgv(applicationId);
  const { id: vaultId } = await storeSecret(b.candidate.id, "bgv_remark", t, ctx.user.id);
  const id = hid("hbg");
  await db.transaction(async (tx) => {
    await tx.insert(hireBackgroundChecks).values({ id, applicationId, required: cur?.required ?? true, status: cur?.status ?? "in_progress", method: cur?.method ?? null, vendor: cur?.vendor ?? null, initiatedOn: cur?.initiatedOn ?? null, completedOn: cur?.completedOn ?? null, checkedById: ctx.user.id, remarkVaultIds: [...(cur?.remarkVaultIds ?? []), vaultId], createdById: ctx.user.id });
    if (cur) await tx.update(hireBackgroundChecks).set({ supersededById: id, updatedAt: new Date() }).where(eq(hireBackgroundChecks.id, cur.id));
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "background_check", entityId: id, event: "background_remark_added", summary: "Added a restricted background-check remark (vaulted)" }, tx);
  });
  return ok(undefined, "Remark stored, restricted.");
}

/** The remarks in clear — the caller holds `bgRemarks`; this writes the PII audit line. */
export async function revealBgvRemarks(ctx: HireContext, applicationId: string): Promise<Result<{ remarks: string[] }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const cur = await currentBgv(applicationId);
  if (!cur?.remarkVaultIds.length) return ok({ remarks: [] });
  const remarks = (await Promise.all(cur.remarkVaultIds.map((v) => reveal(v)))).filter((x): x is string => x != null);
  await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "background_check", entityId: cur.id, event: "pii_unmasked", summary: `Read ${remarks.length} restricted background-check remark${remarks.length === 1 ? "" : "s"}`, pii: ["background_check_remarks"] });
  return ok({ remarks });
}

/* ========================================================== documents ask */

/** PRD §7 — ask for documents. A document already in, or verified, is not asked for again. */
export async function requestDocuments(ctx: HireContext, applicationId: string, keys: string[]): Promise<Result<{ requested: number }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  if (!["in_progress", "on_hold"].includes(b.app.status)) return err(`The application is ${b.app.status.replace("_", " ")}.`, "rule_violation");
  const reqs = b.def.documents.filter((d) => keys.includes(d.key));
  if (!reqs.length) return err("Pick the documents to ask for.", "validation");
  const live = await db.select().from(hireDocuments).where(and(eq(hireDocuments.applicationId, applicationId), isNull(hireDocuments.supersededById)));
  const now = new Date();
  const asked: string[] = [];
  await db.transaction(async (tx) => {
    for (const r of reqs) {
      const cur = live.find((d) => d.requirementKey === r.key);
      if (cur && cur.verificationStatus !== "failed") continue;
      const id = hid("hdo");
      await tx.insert(hireDocuments).values({ id, applicationId, requirementKey: r.key, verificationStatus: "requested", requestedAt: now, requestedById: ctx.user.id, createdById: ctx.user.id });
      if (cur) await tx.update(hireDocuments).set({ supersededById: id, updatedAt: now }).where(eq(hireDocuments.id, cur.id));
      asked.push(r.label);
    }
    if (asked.length) await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "document", event: "documents_requested", summary: `Requested ${asked.join(", ")}` }, tx);
  });
  if (!asked.length) return err("Everything picked is already in.", "rule_violation");
  await recordMessage(ctx, {
    candidateId: b.candidate.id,
    applicationId,
    direction: "out",
    channel: "portal",
    subject: "Documents we need",
    body: `Please send us: ${asked.join("; ")}. A clear photo or PDF of each is enough.`,
    status: "logged",
  });
  return ok({ requested: asked.length }, `Asked for ${asked.length} document${asked.length === 1 ? "" : "s"}.`);
}

/* ================================================================ templates */

export async function listTemplates(): Promise<HireDocTemplate[]> {
  return db.select().from(hireDocTemplates).orderBy(asc(hireDocTemplates.key), desc(hireDocTemplates.version));
}

export async function publishedTemplate(key: string): Promise<HireDocTemplate | null> {
  const [t] = await db.select().from(hireDocTemplates).where(and(eq(hireDocTemplates.key, key), eq(hireDocTemplates.status, "published"))).limit(1);
  return t ?? null;
}

export async function saveTemplate(ctx: HireContext, key: string, input: { title: string; body: string }, publish: boolean): Promise<Result<{ version: number }>> {
  const k = key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(k)) return err("A template key is lower-case letters, digits and dashes.", "validation");
  if (!input.title.trim() || !input.body.trim()) return err("A template needs a title and a body.", "validation");
  const unknown = unknownPlaceholders(input.body);
  if (unknown.length) return err(`Unknown placeholder${unknown.length === 1 ? "" : "s"}: ${unknown.map((u) => `{{${u}}}`).join(", ")}.`, "validation");
  const vs = await db.select().from(hireDocTemplates).where(eq(hireDocTemplates.key, k)).orderBy(desc(hireDocTemplates.version));
  const now = new Date();
  let draft = vs.find((v) => v.status === "draft");
  return db.transaction(async (tx) => {
    if (draft) await tx.update(hireDocTemplates).set({ title: input.title.trim(), body: input.body, updatedAt: now, updatedById: ctx.user.id }).where(eq(hireDocTemplates.id, draft.id));
    else [draft] = await tx.insert(hireDocTemplates).values({ id: hid("htp"), key: k, version: (vs[0]?.version ?? 0) + 1, title: input.title.trim(), body: input.body, status: "draft", createdById: ctx.user.id }).returning();
    if (publish) {
      await tx.update(hireDocTemplates).set({ status: "retired", updatedAt: now }).where(and(eq(hireDocTemplates.key, k), eq(hireDocTemplates.status, "published")));
      await tx.update(hireDocTemplates).set({ status: "published", publishedAt: now, publishedById: ctx.user.id, updatedAt: now }).where(eq(hireDocTemplates.id, draft!.id));
      await hireTrail(ctx, { entityType: "doc_template", entityId: draft!.id, event: "doc_template_published", summary: `Template “${input.title.trim()}” v${draft!.version} published` }, tx);
    }
    return ok({ version: draft!.version }, publish ? `v${draft!.version} published. Documents already prepared keep their wording.` : `Draft v${draft!.version} saved.`);
  });
}

/** The values a template is filled from: the accepted offer and the blueprint, nothing retyped. */
export async function templateValues(b: AppBundle): Promise<Record<string, string>> {
  const o = await currentOffer(b.app.id);
  const plan = await planById(o?.incentivePlanId);
  const long = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${d}T12:00:00+05:30`)) : "[to be agreed]");
  const letter = o ? letterFor(b, o, null, plan ? slabLines(plan) : null) : "";
  const growth = letter.split("\n").filter((l) => l.trim().startsWith("·")).map((l) => l.trim().replace(/^·\s*/, ""));
  return {
    name: b.candidate.fullName,
    first_name: b.candidate.fullName.split(" ")[0],
    role: b.blueprint.title,
    grade: o?.gradeLabel ?? "[grade]",
    location: b.candidate.location ?? b.app.location ?? "[location]",
    basic: o ? `${rupees(o.basicPaise)} a month` : "[basic]",
    ctc: o?.ctcPaise ? `${rupees(o.ctcPaise)} a year` : "[not stated]",
    components: o?.components.length ? o.components.map((c) => `${c.label}: ${rupees(c.amountPaise)}${c.per === "month" ? " a month" : c.per === "year" ? " a year" : " once"}`).join("\n") : "None",
    incentive: o ? (o.incentiveApplicable ? (plan ? `${plan.title} (v${plan.version})${plan.basis ? ` — on ${plan.basis.toLowerCase()}` : ""}` : (o.incentive ?? "")) : "Not applicable") : "[incentive]",
    incentive_slabs: o?.incentiveApplicable && plan ? slabLines(plan).join("\n") : "Not applicable",
    growth_plan: growth.join("\n") || "[growth plan]",
    joining_date: long(o?.joiningDate),
    effective_date: long(o?.effectiveDate ?? o?.joiningDate),
    today: long(todayIst()),
  };
}

/* ===================================================== employment documents */

export async function employmentDocRows(applicationId: string) {
  const rows = await db.select().from(hireEmploymentDocs).where(and(eq(hireEmploymentDocs.applicationId, applicationId), isNull(hireEmploymentDocs.supersededById))).orderBy(asc(hireEmploymentDocs.preparedAt));
  const ids = [...new Set(rows.flatMap((r) => [r.preparedById, r.approvedById, r.sentById, r.filedById]).filter((x): x is string => Boolean(x)))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const fileIds = rows.map((r) => r.signedFileId).filter((x): x is string => Boolean(x));
  const files = fileIds.length ? await db.select({ id: hireFiles.id, filename: hireFiles.filename }).from(hireFiles).where(inArray(hireFiles.id, fileIds)) : [];
  const name = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
  return rows.map((r) => ({ ...r, preparedBy: name(r.preparedById), approvedBy: name(r.approvedById), sentBy: name(r.sentById), signedFile: files.find((f) => f.id === r.signedFileId) ?? null }));
}

function empDocsOpen(b: AppBundle): string | null {
  if (b.app.status !== "in_progress" && b.app.status !== "on_hold") return `The application is ${b.app.status.replace("_", " ")}.`;
  if (!isOnboardingFlow(b.def)) return "This candidate’s blueprint version sends the offer letter only — employment documents start with the onboarding flow.";
  const at = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
  const emp = b.def.stages.findIndex((s) => s.type === "employment_docs");
  if (emp >= 0 && at < emp) return "Employment documents are prepared once documents and the background check are done.";
  return null;
}

/** Prepare every listed document that is not prepared yet (or re-prepare named ones not yet signed). */
export async function prepareEmploymentDocs(ctx: HireContext, applicationId: string, onlyKeys?: string[]): Promise<Result<{ prepared: number }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const closed = empDocsOpen(b);
  if (closed) return err(closed, "rule_violation");
  const offer = await currentOffer(applicationId);
  if (offer?.status !== "accepted") return err("The offer has to be accepted first — the documents carry its figures.", "rule_violation");
  const want = (b.def.employmentDocs ?? []).filter((d) => !onlyKeys || onlyKeys.includes(d.key));
  if (!want.length) return err("This role lists no employment documents.", "rule_violation");
  const live = await db.select().from(hireEmploymentDocs).where(and(eq(hireEmploymentDocs.applicationId, applicationId), isNull(hireEmploymentDocs.supersededById)));
  const values = await templateValues(b);
  const now = new Date();
  const made: string[] = [];
  const missing: string[] = [];
  for (const d of want) {
    const cur = live.find((r) => r.docKey === d.key);
    if (cur && (!onlyKeys || cur.status === "signed" || cur.status === "filed")) continue;
    const t = await publishedTemplate(d.templateKey);
    if (!t) {
      missing.push(d.label);
      continue;
    }
    const id = hid("hed");
    await db.transaction(async (tx) => {
      await tx.insert(hireEmploymentDocs).values({ id, applicationId, docKey: d.key, label: d.label, templateId: t.id, templateVersion: t.version, body: fillTemplate(t.body, values), status: "prepared", hardCopy: d.hardCopy, preparedById: ctx.user.id, preparedAt: now, createdById: ctx.user.id });
      if (cur) await tx.update(hireEmploymentDocs).set({ supersededById: id, updatedAt: now }).where(eq(hireEmploymentDocs.id, cur.id));
    });
    made.push(`${d.label} (${t.title} v${t.version})`);
  }
  if (made.length) await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "employment_doc", event: "employment_docs_prepared", summary: `Prepared ${made.join(", ")}` });
  if (!made.length) return err(missing.length ? `No published template for ${missing.join(", ")}.` : "Everything is already prepared.", "rule_violation");
  return ok({ prepared: made.length }, `Prepared ${made.length}.${missing.length ? ` No published template for ${missing.join(", ")}.` : ""} A second person approves each one.`);
}

async function docForWrite(ctx: HireContext, docId: string) {
  const [d] = await db.select().from(hireEmploymentDocs).where(eq(hireEmploymentDocs.id, docId)).limit(1);
  if (!d || d.supersededById) return { b: null, d: null } as const;
  const b = await getApplication(ctx, d.applicationId);
  return { b, d } as const;
}

/** prepared → approved. The approver is a different person (PRD §9: prepared by, approved by). */
export async function approveEmploymentDoc(ctx: HireContext, docId: string): Promise<Result> {
  const { b, d } = await docForWrite(ctx, docId);
  if (!b || !d) return err("That document is not on your list.", "not_found");
  if (d.status !== "prepared") return err(`It is already ${EMP_DOC_LABEL[d.status as keyof typeof EMP_DOC_LABEL]?.toLowerCase() ?? d.status}.`, "rule_violation");
  if (d.preparedById === ctx.user.id) return err("You prepared it — a second person approves it.", "not_permitted");
  const now = new Date();
  await db.update(hireEmploymentDocs).set({ status: "approved", approvedById: ctx.user.id, approvedAt: now, updatedAt: now, updatedById: ctx.user.id }).where(and(eq(hireEmploymentDocs.id, docId), eq(hireEmploymentDocs.status, "prepared")));
  await hireTrail(ctx, { applicationId: b.app.id, candidateId: b.candidate.id, entityType: "employment_doc", entityId: docId, event: "employment_doc_approved", summary: `Approved ${d.label}` });
  return ok(undefined, `${d.label} approved.`);
}

/** approved → sent, for every approved document picked. Hard copies open an outbound shipment to fill in. */
export async function sendEmploymentDocs(ctx: HireContext, applicationId: string, docIds: string[]): Promise<Result<{ sent: number }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const rows = (await employmentDocRows(applicationId)).filter((r) => docIds.includes(r.id) && r.status === "approved");
  if (!rows.length) return err("Only approved documents are sent.", "rule_violation");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(hireEmploymentDocs).set({ status: "sent", sentById: ctx.user.id, sentAt: now, updatedAt: now }).where(inArray(hireEmploymentDocs.id, rows.map((r) => r.id)));
    const hard = rows.filter((r) => r.hardCopy);
    if (hard.length) {
      const sid = hid("hcs");
      await tx.insert(hireCourierShipments).values({ id: sid, applicationId, direction: "outbound", status: "to_be_sent", docKeys: hard.map((r) => r.docKey), createdById: ctx.user.id });
      await tx.insert(hireCourierEvents).values({ id: hid("hce"), shipmentId: sid, status: "to_be_sent", eventOn: todayIst(), remarks: `Hard copies of ${hard.map((r) => r.label).join(", ")}`, byId: ctx.user.id });
    }
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "employment_doc", event: "employment_docs_sent", summary: `Sent ${rows.map((r) => r.label).join(", ")}${hard.length ? ` · hard copies of ${hard.length} to go by courier` : ""}` }, tx);
  });
  await recordMessage(ctx, { candidateId: b.candidate.id, applicationId, direction: "out", channel: "portal", subject: "Your employment documents", body: `Please read and sign: ${rows.map((r) => r.label).join("; ")}.${rows.some((r) => r.hardCopy) ? " Signed paper copies of some are coming to you by courier — please send them back." : ""}`, status: "logged" });
  return ok({ sent: rows.length }, `Sent ${rows.length}.`);
}

const MAX_BYTES = 10 * 1024 * 1024;

async function storeFile(ctx: HireContext, b: AppBundle, purpose: string, file: File): Promise<Result<{ id: string }>> {
  if (!file || file.size === 0) return err("Choose a file.", "validation");
  if (file.size > MAX_BYTES) return err("Files up to 10 MB.", "validation");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniff(bytes);
  if (!type) return err("That is not a PDF, JPEG, PNG or WebP — whatever its name says.", "validation");
  const id = hid("hfi");
  const stored = await fileStorage.upload({ key: `hire/${b.candidate.id}/${id}`, body: bytes, contentType: type });
  await db.insert(hireFiles).values({ id, candidateId: b.candidate.id, applicationId: b.app.id, purpose, filename: file.name.slice(0, 200) || purpose, contentType: type, sizeBytes: stored.sizeBytes, storedRef: stored.ref, uploadedById: ctx.user.id });
  return ok({ id });
}

/** sent → signed, with the date and (optionally) the signed scan. */
export async function markEmploymentDocSigned(ctx: HireContext, docId: string, signedOn: string, file: File | null): Promise<Result> {
  const { b, d } = await docForWrite(ctx, docId);
  if (!b || !d) return err("That document is not on your list.", "not_found");
  if (d.status !== "sent") return err(d.status === "signed" || d.status === "filed" ? "It is already signed." : "Send it first.", "rule_violation");
  const on = validYmd(signedOn);
  if (!on) return { ok: false, error: "Say when it was signed.", code: "validation", fieldErrors: [{ field: "signedOn", message: "Required" }] };
  if (on > todayIst()) return { ok: false, error: "A signature cannot be dated in the future.", code: "validation", fieldErrors: [{ field: "signedOn", message: "In the future" }] };
  let fileId: string | null = null;
  if (file && file.size) {
    const f = await storeFile(ctx, b, "employment_doc", file);
    if (!f.ok) return f;
    fileId = f.data.id;
  }
  const now = new Date();
  await db.update(hireEmploymentDocs).set({ status: "signed", signedOn: on, signedRecordedById: ctx.user.id, signedFileId: fileId, updatedAt: now, updatedById: ctx.user.id }).where(and(eq(hireEmploymentDocs.id, docId), eq(hireEmploymentDocs.status, "sent")));
  await hireTrail(ctx, { applicationId: b.app.id, candidateId: b.candidate.id, entityType: "employment_doc", entityId: docId, event: "employment_doc_signed", summary: `${d.label} signed on ${on}${fileId ? " · signed copy uploaded" : ""}` });
  await settle(ctx, b);
  return ok(undefined, `${d.label} recorded as signed.`);
}

/** signed → filed: the final copy is in the employee record. Needs the signed scan. */
export async function fileEmploymentDoc(ctx: HireContext, docId: string, file: File | null): Promise<Result> {
  const { b, d } = await docForWrite(ctx, docId);
  if (!b || !d) return err("That document is not on your list.", "not_found");
  if (d.status !== "signed") return err("Only a signed document is filed.", "rule_violation");
  let fileId = d.signedFileId;
  if (file && file.size) {
    const f = await storeFile(ctx, b, "employment_doc", file);
    if (!f.ok) return f;
    fileId = f.data.id;
  }
  if (!fileId) return { ok: false, error: "Upload the signed copy to file it.", code: "validation", fieldErrors: [{ field: "file", message: "Required" }] };
  const now = new Date();
  await db.update(hireEmploymentDocs).set({ status: "filed", signedFileId: fileId, filedById: ctx.user.id, filedAt: now, updatedAt: now }).where(and(eq(hireEmploymentDocs.id, docId), eq(hireEmploymentDocs.status, "signed")));
  await hireTrail(ctx, { applicationId: b.app.id, candidateId: b.candidate.id, entityType: "employment_doc", entityId: docId, event: "employment_doc_filed", summary: `${d.label} filed with the signed copy` });
  return ok(undefined, `${d.label} filed.`);
}


/* ================================================================== courier */

export async function shipments(applicationId: string) {
  const s = await db.select().from(hireCourierShipments).where(eq(hireCourierShipments.applicationId, applicationId)).orderBy(asc(hireCourierShipments.createdAt));
  if (!s.length) return [];
  const ev = await db.select({ e: hireCourierEvents, by: users.name }).from(hireCourierEvents).leftJoin(users, eq(users.id, hireCourierEvents.byId)).where(inArray(hireCourierEvents.shipmentId, s.map((x) => x.id))).orderBy(asc(hireCourierEvents.at));
  return s.map((x) => ({ ...x, events: ev.filter((e) => e.e.shipmentId === x.id).map((e) => ({ ...e.e, byName: e.by })) }));
}

export type ShipmentInput = { direction: "outbound" | "return"; company?: string | null; trackingNo?: string | null; status: string; on: string; dueOn?: string | null; remarks?: string | null; docKeys?: string[] };

export async function addShipment(ctx: HireContext, applicationId: string, input: ShipmentInput): Promise<Result<{ id: string }>> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  if (input.direction !== "outbound" && input.direction !== "return") return err("Pick a direction.", "validation");
  if (!COURIER_FLOW[input.direction].includes(input.status as CourierStatus) && input.status !== "issue") return err(`A ${input.direction} shipment is ${COURIER_FLOW[input.direction].map((s) => COURIER_STATUS_LABEL[s]).join(", ")} or Issue.`, "validation");
  const on = validYmd(input.on);
  if (!on) return { ok: false, error: "Give the date.", code: "validation", fieldErrors: [{ field: "on", message: "Required" }] };
  const id = hid("hcs");
  await db.transaction(async (tx) => {
    await tx.insert(hireCourierShipments).values({ id, applicationId, direction: input.direction, company: input.company?.trim() || null, trackingNo: input.trackingNo?.trim() || null, docKeys: input.docKeys ?? [], status: input.status, dueOn: validYmd(input.dueOn), createdById: ctx.user.id });
    await tx.insert(hireCourierEvents).values({ id: hid("hce"), shipmentId: id, status: input.status, eventOn: on, remarks: input.remarks?.trim() || null, byId: ctx.user.id });
    await hireTrail(ctx, { applicationId, candidateId: b.candidate.id, entityType: "courier", entityId: id, event: "courier_added", summary: `${input.direction === "outbound" ? "Outbound" : "Return"} courier${input.company ? ` · ${input.company}` : ""}${input.trackingNo ? ` · ${input.trackingNo}` : ""} · ${COURIER_STATUS_LABEL[input.status as CourierStatus]}` }, tx);
  });
  await settle(ctx, b);
  return ok({ id }, "Shipment recorded.");
}

/** A new status on a shipment. The events are append-only; the shipment's status is the newest. */
export async function courierEvent(ctx: HireContext, shipmentId: string, input: { status: string; on: string; remarks?: string | null; company?: string | null; trackingNo?: string | null }): Promise<Result> {
  const [s] = await db.select().from(hireCourierShipments).where(eq(hireCourierShipments.id, shipmentId)).limit(1);
  if (!s) return err("That shipment does not exist.", "not_found");
  const b = await getApplication(ctx, s.applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  if (!(COURIER_STATUSES as readonly string[]).includes(input.status)) return err("Unknown courier status.", "validation");
  if (input.status !== "issue" && !COURIER_FLOW[s.direction as "outbound" | "return"].includes(input.status as CourierStatus)) return err("That status is for the other direction.", "validation");
  const on = validYmd(input.on);
  if (!on) return { ok: false, error: "Give the date.", code: "validation", fieldErrors: [{ field: "on", message: "Required" }] };
  if (on > todayIst()) return { ok: false, error: "That date is in the future.", code: "validation", fieldErrors: [{ field: "on", message: "In the future" }] };
  await db.transaction(async (tx) => {
    await tx.insert(hireCourierEvents).values({ id: hid("hce"), shipmentId, status: input.status, eventOn: on, remarks: input.remarks?.trim() || null, byId: ctx.user.id });
    await tx
      .update(hireCourierShipments)
      .set({ status: input.status, company: input.company?.trim() || s.company, trackingNo: input.trackingNo?.trim() || s.trackingNo, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(hireCourierShipments.id, shipmentId));
    await hireTrail(ctx, { applicationId: s.applicationId, candidateId: b.candidate.id, entityType: "courier", entityId: shipmentId, event: "courier_status", summary: `${s.direction === "outbound" ? "Outbound" : "Return"} courier: ${COURIER_STATUS_LABEL[input.status as CourierStatus]} on ${on}${input.remarks?.trim() ? ` · “${input.remarks.trim()}”` : ""}` }, tx);
  });
  /* Delivered outbound: the signed copies are now awaited — open the return leg for them. */
  if (s.direction === "outbound" && input.status === "delivered") {
    const [ret] = await db.select({ id: hireCourierShipments.id }).from(hireCourierShipments).where(and(eq(hireCourierShipments.applicationId, s.applicationId), eq(hireCourierShipments.direction, "return"))).limit(1);
    if (!ret) {
      const days = (await (await import("@/lib/config/store")).getConfig())["hire.reminders.courierDays"];
      const due = calendarDate(new Date(Date.parse(`${on}T12:00:00+05:30`) + days * 86_400_000));
      await addShipment(ctx, s.applicationId, { direction: "return", status: "awaited", on, dueOn: due, docKeys: s.docKeys, remarks: "Opened when the outbound copies were delivered" });
    }
  }
  await settle(ctx, b);
  return ok(undefined, "Saved.");
}

/* =================================================================== assets */

export type AssetRow = { key: string; label: string; serialNeeded: boolean; acknowledge: boolean; row: HireAssetIssue | null; applicable: boolean; issuedBy: string | null; history: number };

export async function assetRows(b: AppBundle): Promise<AssetRow[]> {
  const all = await db.select().from(hireAssetIssues).where(eq(hireAssetIssues.applicationId, b.app.id)).orderBy(desc(hireAssetIssues.createdAt));
  const live = all.filter((r) => !r.supersededById);
  const ids = [...new Set(live.map((r) => r.issuedById).filter((x): x is string => Boolean(x)))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  return b.def.onboarding.assets.map((a) => {
    const row = live.find((r) => r.assetKey === a.key) ?? null;
    return { key: a.key, label: a.label, serialNeeded: a.serial, acknowledge: Boolean(a.acknowledge), row, applicable: row ? row.applicable : (a.applicableByDefault ?? true), issuedBy: row?.issuedById ? (people.find((p) => p.id === row.issuedById)?.name ?? null) : null, history: all.filter((r) => r.assetKey === a.key).length };
  });
}

export async function assetHistory(applicationId: string) {
  return db
    .select({ a: hireAssetIssues, by: users.name })
    .from(hireAssetIssues)
    .leftJoin(users, eq(users.id, hireAssetIssues.createdById))
    .where(eq(hireAssetIssues.applicationId, applicationId))
    .orderBy(desc(hireAssetIssues.createdAt));
}

function assetsOpen(b: AppBundle): string | null {
  if (isOnboardingFlow(b.def)) {
    if (b.app.status !== "hired" || b.app.onboardingCompletedAt) return b.app.status === "hired" ? "Onboarding is complete." : "Assets are issued once their account is created on Provision.";
    return null;
  }
  return b.app.status === "in_progress" ? null : `The application is ${b.app.status.replace("_", " ")}.`;
}

/** A new live row for an asset, superseding the last — the history is the rows. */
async function writeAsset(ctx: HireContext, b: AppBundle, key: string, patch: Partial<typeof hireAssetIssues.$inferInsert>, event: string, summary: string) {
  const a = b.def.onboarding.assets.find((x) => x.key === key)!;
  const cur = (await liveAssets(b.app.id)).find((r) => r.assetKey === key) ?? null;
  const id = hid("hai");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(hireAssetIssues).values({
      id,
      applicationId: b.app.id,
      assetKey: key,
      label: a.label,
      applicable: cur?.applicable ?? (a.applicableByDefault ?? true),
      notApplicableReason: cur?.notApplicableReason ?? null,
      serial: cur?.serial ?? null,
      issuedOn: cur?.issuedOn ?? null,
      issuedById: cur?.issuedById ?? null,
      acknowledgedAt: cur?.acknowledgedAt ?? null,
      ackMethod: cur?.ackMethod ?? null,
      ackFileId: cur?.ackFileId ?? null,
      problem: cur?.problem ?? null,
      returnedOn: cur?.returnedOn ?? null,
      ...patch,
      createdById: ctx.user.id,
    });
    if (cur) await tx.update(hireAssetIssues).set({ supersededById: id, updatedAt: now }).where(eq(hireAssetIssues.id, cur.id));
    await hireTrail(ctx, { applicationId: b.app.id, candidateId: b.candidate.id, entityType: "asset", entityId: id, event, summary, before: cur ? { applicable: cur.applicable, serial: cur.serial, issuedOn: cur.issuedOn, acknowledgedAt: cur.acknowledgedAt } : null }, tx);
  });
  return id;
}

export async function issueAsset(ctx: HireContext, applicationId: string, key: string, input: { serial?: string | null; issuedOn: string }): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const closed = assetsOpen(b);
  if (closed) return err(closed, "rule_violation");
  const a = b.def.onboarding.assets.find((x) => x.key === key);
  if (!a) return err("That asset is not in this role’s onboarding plan.", "validation");
  const serial = input.serial?.trim() || null;
  if (a.serial && !serial) return { ok: false, error: `${a.label} needs its serial or reference number.`, code: "validation", fieldErrors: [{ field: "serial", message: "Required" }] };
  const on = validYmd(input.issuedOn);
  if (!on) return { ok: false, error: "Say when it was issued.", code: "validation", fieldErrors: [{ field: "issuedOn", message: "Required" }] };
  if (on > todayIst()) return { ok: false, error: "An issue date cannot be in the future.", code: "validation", fieldErrors: [{ field: "issuedOn", message: "In the future" }] };
  await writeAsset(ctx, b, key, { applicable: true, notApplicableReason: null, serial, issuedOn: on, issuedById: ctx.user.id, acknowledgedAt: null, ackMethod: null, ackFileId: null, problem: null, returnedOn: null }, "asset_issued", `Issued ${a.label}${serial ? ` · ${serial}` : ""} on ${on}`);
  if (b.app.employeeUserId && a.acknowledge) {
    const { notifyUsers } = await import("@/lib/notify");
    await notifyUsers([{ userId: b.app.employeeUserId, title: `Please confirm you received: ${a.label}`, body: "Open Training → Assets and tap I have it, or tell us what is wrong.", href: "/learn/assets" }]).catch(() => []);
  }
  await settle(ctx, b);
  return ok(undefined, `${a.label} issued.`);
}

export async function setAssetApplicable(ctx: HireContext, applicationId: string, key: string, applicable: boolean, reason: string): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const closed = assetsOpen(b);
  if (closed) return err(closed, "rule_violation");
  const a = b.def.onboarding.assets.find((x) => x.key === key);
  if (!a) return err("That asset is not in this role’s onboarding plan.", "validation");
  if (!applicable && reason.trim().length < 10) return { ok: false, error: "Say why it does not apply — it is kept on the record.", code: "validation", fieldErrors: [{ field: "reason", message: "At least 10 characters" }] };
  await writeAsset(ctx, b, key, { applicable, notApplicableReason: applicable ? null : reason.trim() }, applicable ? "asset_applicable" : "asset_not_applicable", applicable ? `${a.label} applies` : `${a.label} not applicable · “${reason.trim()}”`);
  await settle(ctx, b);
  return ok(undefined, applicable ? `${a.label} applies again.` : `${a.label} marked not applicable.`);
}

/** A signed acknowledgement slip, for somebody who cannot use the app. */
export async function acknowledgeAssetBySlip(ctx: HireContext, applicationId: string, key: string, file: File): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const cur = (await liveAssets(applicationId)).find((r) => r.assetKey === key);
  if (!cur?.issuedOn) return err("Issue it first.", "rule_violation");
  if (cur.acknowledgedAt) return err("It is already acknowledged.", "rule_violation");
  const f = await storeFile(ctx, b, "asset_slip", file);
  if (!f.ok) return f;
  await writeAsset(ctx, b, key, { acknowledgedAt: new Date(), ackMethod: "signed_slip", ackFileId: f.data.id, problem: null }, "asset_acknowledged", `${cur.label} acknowledged · signed slip uploaded`);
  await settle(ctx, b);
  return ok(undefined, "Acknowledged with the signed slip.");
}

export async function returnAsset(ctx: HireContext, applicationId: string, key: string, returnedOn: string): Promise<Result> {
  const b = await getApplication(ctx, applicationId);
  if (!b) return err("That candidate is not on your list.", "not_found");
  const cur = (await liveAssets(applicationId)).find((r) => r.assetKey === key);
  if (!cur?.issuedOn) return err("It was never issued.", "rule_violation");
  const on = validYmd(returnedOn);
  if (!on) return err("Say when it came back.", "validation");
  await writeAsset(ctx, b, key, { returnedOn: on, issuedOn: null, acknowledgedAt: null, ackMethod: null }, "asset_returned", `${cur.label} returned on ${on}`);
  await settle(ctx, b);
  return ok(undefined, "Recorded as returned — issue it again to replace it.");
}

/* ------------------------------------------------------------- the learner */

/** The assets issued to this employee, through every application they were hired from. */
export async function myAssets(userId: string) {
  return db
    .select({ a: hireAssetIssues, by: users.name })
    .from(hireAssetIssues)
    .innerJoin(hireApplications, eq(hireApplications.id, hireAssetIssues.applicationId))
    .leftJoin(users, eq(users.id, hireAssetIssues.issuedById))
    .where(and(eq(hireApplications.employeeUserId, userId), isNull(hireAssetIssues.supersededById), eq(hireAssetIssues.applicable, true), sql`${hireAssetIssues.issuedOn} is not null`))
    .orderBy(asc(hireAssetIssues.acknowledgedAt), asc(hireAssetIssues.label));
}

/** The employee's own acknowledgement — or what is wrong instead. Only their own assets. */
export async function acknowledgeMyAsset(userId: string, assetIssueId: string, problem: string | null): Promise<Result> {
  const [r] = await db
    .select({ a: hireAssetIssues, app: hireApplications, name: users.name })
    .from(hireAssetIssues)
    .innerJoin(hireApplications, eq(hireApplications.id, hireAssetIssues.applicationId))
    .innerJoin(users, eq(users.id, userId))
    .where(and(eq(hireAssetIssues.id, assetIssueId), eq(hireApplications.employeeUserId, userId)))
    .limit(1);
  if (!r) return err("That is not one of your assets.", "not_found");
  if (r.a.supersededById) return err("That record has changed — reload the page.", "conflict");
  if (!r.a.issuedOn) return err("It has not been issued to you.", "rule_violation");
  if (r.a.acknowledgedAt) return err("You have already confirmed it.", "rule_violation");
  const p = problem?.trim() || null;
  if (problem != null && (!p || p.length < 5)) return { ok: false, error: "Say what is wrong.", code: "validation", fieldErrors: [{ field: "problem", message: "Required" }] };
  const id = hid("hai");
  const now = new Date();
  const actor = { user: { id: userId, name: r.name }, roleLabel: "Employee" } as Parameters<typeof hireTrail>[0];
  await db.transaction(async (tx) => {
    await tx.insert(hireAssetIssues).values({ ...r.a, id, supersededById: null, acknowledgedAt: p ? null : now, ackMethod: p ? null : "in_app", problem: p, createdAt: now, updatedAt: now, createdById: userId });
    await tx.update(hireAssetIssues).set({ supersededById: id, updatedAt: now }).where(eq(hireAssetIssues.id, r.a.id));
    await hireTrail(actor, { applicationId: r.app.id, candidateId: r.app.candidateId, entityType: "asset", entityId: id, event: p ? "asset_problem" : "asset_acknowledged", summary: p ? `${r.a.label}: employee reported a problem · “${p}”` : `${r.a.label} acknowledged by the employee in the Training app` }, tx);
  });
  if (p && r.app.recruiterId) {
    const { notifyUsers } = await import("@/lib/notify");
    await notifyUsers([{ userId: r.app.recruiterId, title: `${r.name} reported a problem with ${r.a.label}`, body: p, href: `/hire/induction?app=${r.app.id}` }]).catch(() => []);
  }
  /* Their acknowledgement may close the stage; that is the system acting. */
  await refreshStageAsSystem(r.app.id, userId, r.name);
  return ok(undefined, p ? "Thanks — we will sort it out." : "Confirmed. Thank you.");
}

/** Re-read the stage after the employee did something, as the system, without a Hire role. */
async function refreshStageAsSystem(applicationId: string, userId: string, name: string) {
  const { stageOutcome, ensureExecution } = await import("./core");
  const { hireStageExecutions, hireBlueprints } = await import("@/db/schema");
  const [a] = await db.select().from(hireApplications).where(eq(hireApplications.id, applicationId)).limit(1);
  if (!a) return;
  const [bp] = await db.select({ d: hireBlueprints.definition }).from(hireBlueprints).where(eq(hireBlueprints.id, a.blueprintId)).limit(1);
  const def = bp?.d as BlueprintDefinition | undefined;
  const stage = def ? stageByKey(def, a.stageKey) : undefined;
  if (!def || !stage || stage.type !== "checklist") return;
  const oc = await stageOutcome(a, def);
  if (oc.outcome !== "pass") return;
  const ex = await ensureExecution(a.id, stage, userId);
  const now = new Date();
  await db.update(hireStageExecutions).set({ status: "completed", outcome: "pass", completedAt: now, updatedAt: now }).where(eq(hireStageExecutions.id, ex.id));
  const i = def.stages.findIndex((s) => s.key === stage.key);
  const next = def.stages[i + 1];
  const actor = { user: { id: userId, name }, roleLabel: "Employee" } as Parameters<typeof hireTrail>[0];
  if (next) {
    await db.update(hireApplications).set({ stageKey: next.key, stageEnteredAt: now, updatedAt: now }).where(eq(hireApplications.id, a.id));
    await ensureExecution(a.id, next, userId);
    await hireTrail(actor, { applicationId: a.id, candidateId: a.candidateId, entityType: "application", entityId: a.id, event: "stage_move", summary: `Moved ${stage.name} → ${next.name} · every asset acknowledged` });
  } else {
    await db.update(hireApplications).set({ onboardingCompletedAt: now, updatedAt: now }).where(and(eq(hireApplications.id, a.id), isNull(hireApplications.onboardingCompletedAt)));
    await hireTrail(actor, { applicationId: a.id, candidateId: a.candidateId, entityType: "application", entityId: a.id, event: "onboarding_completed", summary: "Onboarding completed · every asset acknowledged" });
  }
}

/* ================================================================== offers */

/** The plans an offer for this role may name, newest version of each. */
export async function plansForRole(def: BlueprintDefinition) {
  return publishedPlans(def.offer.incentivePlanKeys ?? []);
}

