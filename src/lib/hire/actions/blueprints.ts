"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { hireBlueprints } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import { HireNotPermitted, requireHireCap, type HireContext } from "../access";
import { audit, hid } from "../services/core";
import { blankDefinition, freeKey, getBlueprintRow, publishedForCopy, studioIssues, type StudioDefinition } from "../services/blueprints";
import { blocking } from "../engines/validator";
import { critiqueRubric } from "../ai/rubric-critic";
import { assembleDefinition, generateStep, type GenParts, type GenStep, type Intake } from "../ai/generate-blueprint";

/* ---------------------------------------------------------------------------
 * Writes to blueprints. A PUBLISHED row is never updated again except to be
 * retired when its successor publishes; editing one means a new draft
 * version. Drafts are edited by anybody who may propose (Hiring Manager) or
 * edit (HR Head, Admin); publishing is HR Head and Admin only.
 * ------------------------------------------------------------------------- */

async function editor(): Promise<HireContext> {
  const ctx = await requireHireCap();
  if (!ctx.can("editBp") && !ctx.can("proposeBp")) throw new HireNotPermitted("Editing a blueprint needs a Hiring Manager, HR Head or Admin.");
  return ctx;
}

function guard<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  return fn().catch((e) => {
    if (e instanceof HireNotPermitted) return err(e.message, "not_permitted");
    console.error("hire blueprints:", e);
    return err(e instanceof Error ? e.message : "That could not be saved.");
  });
}

export type IdentityInput = { title: string; family: string; department: string; level: string; employmentType: string; locations: string[]; headcount: number; retentionMonths: number };

/** Save a draft: identity columns and the whole definition, in one write. */
export async function saveDraft(id: string, identity: IdentityInput, definition: StudioDefinition, note?: string): Promise<Result> {
  return guard(async () => {
    const ctx = await editor();
    const b = await getBlueprintRow(id);
    if (!b) return err("That blueprint no longer exists.", "not_found");
    if (b.status !== "draft") return err("A published version cannot change. Start a new version to edit it.", "rule_violation");
    if (!identity.title.trim()) return { ok: false, error: "A role needs a title.", code: "validation", fieldErrors: [{ field: "title", message: "Required" }] };
    for (const s of definition.stages) s.maxPoints = s.questions.reduce((n, q) => n + (Number(q.maxPoints) || 0), 0);
    await db
      .update(hireBlueprints)
      .set({
        title: identity.title.trim(),
        family: identity.family.trim() || b.family,
        department: identity.department.trim() || b.department,
        level: identity.level.trim() || b.level,
        employmentType: identity.employmentType.trim() || b.employmentType,
        locations: identity.locations.map((l) => l.trim()).filter(Boolean),
        headcount: Math.max(1, Math.round(identity.headcount) || 1),
        retentionMonths: Math.max(1, Math.round(identity.retentionMonths) || 24),
        definition,
        updatedAt: new Date(),
        updatedById: ctx.user.id,
      })
      .where(and(eq(hireBlueprints.id, id), eq(hireBlueprints.status, "draft")));
    await audit(ctx, { entityType: "blueprint", entityId: id, eventType: "blueprint_saved", summary: `${identity.title} v${b.version} draft saved${note ? ` · ${note}` : ""}` });
    revalidatePath(`/hire/blueprints/${id}`);
    return ok(undefined, "Saved.");
  });
}

/** Run the rubric critic on a draft and keep its findings with it. */
export async function runCritic(id: string): Promise<Result<{ findings: number }>> {
  return guard(async () => {
    const ctx = await editor();
    const b = await getBlueprintRow(id);
    if (!b) return err("Not found.", "not_found");
    if (b.status !== "draft") return err("The critic reviews drafts.", "rule_violation");
    const r = await critiqueRubric(b.definition, { title: b.title, blueprintId: b.id, actorId: ctx.user.id });
    if (!r.ok) return err(r.reason);
    await db.update(hireBlueprints).set({ critic: r.output, updatedAt: new Date() }).where(and(eq(hireBlueprints.id, id), eq(hireBlueprints.status, "draft")));
    await audit(ctx, { entityType: "blueprint", entityId: id, eventType: "rubric_critic", summary: `Rubric critic: ${r.output.length} finding${r.output.length === 1 ? "" : "s"}`, aiTaskId: r.taskId || null });
    revalidatePath(`/hire/blueprints/${id}`);
    return ok({ findings: r.output.length }, r.output.length ? `${r.output.length} things for a person to look at.` : "The critic found nothing to flag.");
  });
}

/** Publish a draft. The version before it retires; nobody on it moves. */
export async function publishBlueprint(id: string): Promise<Result> {
  return guard(async () => {
    const ctx = await requireHireCap("publish");
    const b = await getBlueprintRow(id);
    if (!b) return err("Not found.", "not_found");
    if (b.status !== "draft") return err("Only a draft can be published.", "rule_violation");
    const errors = blocking(studioIssues(b.definition));
    if (errors.length) return err(`${errors.length} error${errors.length === 1 ? "" : "s"} must be fixed first — see Validation.`, "rule_violation");
    const retired: number[] = [];
    await db.transaction(async (tx) => {
      const live = await tx.select({ id: hireBlueprints.id, version: hireBlueprints.version }).from(hireBlueprints).where(and(eq(hireBlueprints.key, b.key), eq(hireBlueprints.status, "published")));
      for (const l of live) {
        await tx.update(hireBlueprints).set({ status: "retired", retiredAt: new Date() }).where(eq(hireBlueprints.id, l.id));
        retired.push(l.version);
      }
      await tx.update(hireBlueprints).set({ status: "published", publishedAt: new Date(), publishedById: ctx.user.id, updatedAt: new Date(), updatedById: ctx.user.id }).where(eq(hireBlueprints.id, id));
      await audit(
        ctx,
        { entityType: "blueprint", entityId: id, eventType: "blueprint_published", summary: `Published ${b.title} v${b.version}${retired.length ? ` · v${retired.join(", v")} retired; candidates on it stay on it` : ""}` },
        tx,
      );
    });
    revalidatePath("/hire/blueprints");
    return ok(undefined, `${b.title} v${b.version} is published.${retired.length ? ` Candidates already on v${retired.join(", v")} stay on it for their whole journey.` : ""}`);
  });
}

/** Start the next version of a blueprint as a draft — or open the draft that already exists. */
export async function newVersion(id: string): Promise<Result<{ id: string }>> {
  return guard(async () => {
    const ctx = await editor();
    const b = await getBlueprintRow(id);
    if (!b) return err("Not found.", "not_found");
    const all = await db.select({ id: hireBlueprints.id, version: hireBlueprints.version, status: hireBlueprints.status }).from(hireBlueprints).where(eq(hireBlueprints.key, b.key));
    const draft = all.find((x) => x.status === "draft");
    if (draft) return ok({ id: draft.id }, `v${draft.version} is already being drafted — opening it.`);
    const version = Math.max(...all.map((x) => x.version)) + 1;
    const newId = hid("hbp");
    await db.insert(hireBlueprints).values({
      id: newId,
      key: b.key,
      version,
      status: "draft",
      title: b.title,
      family: b.family,
      department: b.department,
      level: b.level,
      employmentType: b.employmentType,
      locations: b.locations,
      headcount: b.headcount,
      descriptionSource: b.descriptionSource,
      aiGenerated: false,
      parentId: b.id,
      definition: structuredClone(b.definition),
      retentionMonths: b.retentionMonths,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    await audit(ctx, { entityType: "blueprint", entityId: newId, eventType: "blueprint_version", summary: `Started ${b.title} v${version} from v${b.version}` });
    return ok({ id: newId }, `Drafting v${version}. v${b.version} stays exactly as it is until this is published.`);
  });
}

/** A new role, copied from an existing blueprint. */
export async function copyToNewRole(fromId: string, title: string): Promise<Result<{ id: string }>> {
  return guard(async () => {
    const ctx = await editor();
    const b = await getBlueprintRow(fromId);
    if (!b) return err("Not found.", "not_found");
    const t = title.trim() || `${b.title} (copy)`;
    const def = structuredClone(b.definition) as StudioDefinition;
    const newId = hid("hbp");
    await db.insert(hireBlueprints).values({
      id: newId,
      key: await freeKey(t),
      version: 1,
      status: "draft",
      title: t,
      family: b.family,
      department: b.department,
      level: b.level,
      employmentType: b.employmentType,
      locations: b.locations,
      headcount: 1,
      descriptionSource: `Started from ${b.title} v${b.version}.`,
      aiGenerated: false,
      definition: def,
      retentionMonths: b.retentionMonths,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    await audit(ctx, { entityType: "blueprint", entityId: newId, eventType: "blueprint_created", summary: `New role “${t}” started from ${b.title} v${b.version}` });
    return ok({ id: newId }, `“${t}” started from ${b.title}. Review every section before publishing.`);
  });
}

export async function createBlank(title: string, family: string, department: string): Promise<Result<{ id: string }>> {
  return guard(async () => {
    const ctx = await editor();
    if (!title.trim()) return { ok: false, error: "A role needs a title.", code: "validation", fieldErrors: [{ field: "title", message: "Required" }] };
    const newId = hid("hbp");
    await db.insert(hireBlueprints).values({
      id: newId,
      key: await freeKey(title),
      version: 1,
      status: "draft",
      title: title.trim(),
      family: family.trim() || "Other",
      department: department.trim() || "Office",
      definition: blankDefinition(),
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    await audit(ctx, { entityType: "blueprint", entityId: newId, eventType: "blueprint_created", summary: `New role “${title.trim()}” started from a blank skeleton` });
    return ok({ id: newId });
  });
}

/* ------------------------------------------------------------- generation */

export async function generateBlueprintStep(step: GenStep, intake: Intake, parts: GenParts): Promise<Result<GenParts>> {
  return guard(async () => {
    const ctx = await editor();
    if (!intake.jd?.trim() && !intake.six?.title?.trim()) return err("Paste a job description, or answer the six questions.", "validation");
    const similar = (await publishedForCopy()).map((b) => `${b.title} (${b.family})`).slice(0, 12);
    const r = await generateStep(step, intake, parts, { actorId: ctx.user.id, similar });
    return r.ok ? ok(r.parts) : err(r.reason);
  });
}

/** Save what the generator drafted as a version-1 draft, and run the critic on it before anybody reads it. */
export async function saveGenerated(intake: Intake, parts: GenParts): Promise<Result<{ id: string }>> {
  return guard(async () => {
    const ctx = await editor();
    const { def, identity } = assembleDefinition(parts);
    const title = identity?.title?.trim() || intake.six?.title?.trim() || "New role";
    const newId = hid("hbp");
    await db.insert(hireBlueprints).values({
      id: newId,
      key: await freeKey(title),
      version: 1,
      status: "draft",
      title,
      family: identity?.family || "Other",
      department: identity?.department || "Office",
      level: identity?.level || "Executive",
      employmentType: identity?.employmentType || "Full time",
      locations: identity?.locations ?? [],
      headcount: Math.max(1, identity?.headcount ?? 1),
      descriptionSource: intake.jd?.trim() || Object.entries(intake.six ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n"),
      aiGenerated: true,
      generationPromptVersion: "blueprint/v1",
      definition: def,
      createdById: ctx.user.id,
      updatedById: ctx.user.id,
    });
    await audit(ctx, { entityType: "blueprint", entityId: newId, eventType: "blueprint_generated", summary: `AI drafted “${title}” — nothing approved yet` });
    const c = await critiqueRubric(def, { title, blueprintId: newId, actorId: ctx.user.id });
    if (c.ok) await db.update(hireBlueprints).set({ critic: c.output }).where(eq(hireBlueprints.id, newId));
    return ok({ id: newId }, "Drafted. Review and approve every element before publishing.");
  });
}
