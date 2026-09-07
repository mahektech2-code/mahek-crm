"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  expenseCityClasses,
  expenseGradeMap,
  expenseGrades,
  expensePolicies,
  expensePolicyRules,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCapability } from "@/lib/access-control";
import { validateRule, ruleSpec, type RuleDraft } from "@/lib/expense-rule-forms";
import {
  currentlyInForce,
  nextVersionNo,
  normaliseKey,
  readPolicy,
} from "@/lib/services/expense-policy-service";
import { today } from "@/lib/recompute";
import { err as fail, ok, okVoid, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Writing the expense policy.
 *
 * Two capabilities, deliberately. `expense.policy.write` is accounts' and
 * admin's — a manager may not author the rules for what their own team's
 * travelling is allowed to cost, which is the conflict `order.approve` exists
 * to avoid one level up. `expense.policy.publish` is admin's alone, because
 * requirement 4 asks for somebody to VERIFY before a policy goes live and
 * verification by whoever typed the rates is not verification.
 *
 * Both are checked here and not merely hidden on the console. A server action
 * is a URL.
 *
 * One rule runs through the file: **a published version is never edited.**
 * Every write below refuses one, because requirement 6 rests on a published
 * version being immutable — an old claim re-read has to get the answer it got
 * the first time, and it only can if there was nothing that could have moved.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function author() {
  await requireCapability("expense.policy.write");
  return requireUser();
}

async function audit(
  userId: string,
  action: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId: userId,
    action,
    entityType: "expense_policy",
    entityId,
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

function refresh() {
  try {
    revalidatePath("/admin/expense-policy");
    revalidatePath("/sales/expense-policy");
  } catch {
    /* No request scope — nothing cached to drop. */
  }
}

/** A version that may still be changed, or the reason it may not. */
async function editableDraft(policyId: string) {
  const [row] = await db
    .select({ id: expensePolicies.id, status: expensePolicies.status, versionNo: expensePolicies.versionNo })
    .from(expensePolicies)
    .where(eq(expensePolicies.id, policyId))
    .limit(1);
  if (!row) return { ok: false as const, value: fail("There is no policy version with that id.", "not_found") };
  if (row.status !== "draft") {
    return {
      ok: false as const,
      value: fail(
        `Version ${row.versionNo} is ${row.status} and cannot be edited. Every expense already claimed was worked out against it, so changing it would silently restate them — make a new version instead.`,
        "rule_violation",
      ),
    };
  }
  return { ok: true as const, row };
}

/* ------------------------------------------------------------- the version */

const draftSchema = z.object({
  title: z.string().trim().min(3).max(200),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date, as YYYY-MM-DD."),
  notes: z.string().trim().max(4000).nullish(),
  sourceAttachmentId: z.string().nullish(),
  /** Copy every rule of an existing version into the new draft. */
  copyFromPolicyId: z.string().nullish(),
});

/**
 * A new draft.
 *
 * `copyFromPolicyId` is not a convenience. A policy revision is almost always
 * "last year's document with three numbers changed", and retyping forty rules
 * to change three is how the other thirty-seven acquire a typo nobody is
 * looking for. Copying is the ordinary path and starting empty is the rare one.
 */
export async function createPolicyDraft(input: unknown): Promise<Result<{ id: string; versionNo: number }>> {
  const user = await author();
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) {
    return fail("That draft cannot be created.", "validation", parsed.error.issues.map((i) => ({
      field: String(i.path[0] ?? "form"),
      message: i.message,
    })));
  }
  const p = parsed.data;
  const versionNo = await nextVersionNo();
  const id = newId("xpol");

  await db.insert(expensePolicies).values({
    id,
    versionNo,
    title: p.title,
    status: "draft",
    effectiveFrom: p.effectiveFrom,
    notes: p.notes ?? null,
    sourceAttachmentId: p.sourceAttachmentId ?? null,
    createdById: user.id,
    updatedById: user.id,
  });

  let copied = 0;
  if (p.copyFromPolicyId) {
    const source = await db
      .select()
      .from(expensePolicyRules)
      .where(eq(expensePolicyRules.policyId, p.copyFromPolicyId));
    if (source.length) {
      await db.insert(expensePolicyRules).values(
        source.map((r) => ({
          id: newId("xrule"),
          policyId: id,
          kind: r.kind,
          scopeKey: r.scopeKey,
          grade: r.grade,
          cityClass: r.cityClass,
          valueJson: r.valueJson,
          sequence: r.sequence,
        })),
      );
      copied = source.length;
    }
  }

  await audit(user.id, "expense_policy.draft_created", id, null, { versionNo, title: p.title, copied });
  refresh();
  return ok(
    { id, versionNo },
    copied
      ? `Version ${versionNo} created as a draft, with ${copied} rule${copied === 1 ? "" : "s"} copied across.`
      : `Version ${versionNo} created as a draft.`,
  );
}

const updateSchema = z.object({
  policyId: z.string(),
  title: z.string().trim().min(3).max(200).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().trim().max(4000).nullish(),
  sourceAttachmentId: z.string().nullish(),
});

export async function updatePolicyDraft(input: unknown): Promise<Result> {
  const user = await author();
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail("That change cannot be saved.", "validation");
  const p = parsed.data;

  const guard = await editableDraft(p.policyId);
  if (!guard.ok) return guard.value;

  const before = await db
    .select()
    .from(expensePolicies)
    .where(eq(expensePolicies.id, p.policyId))
    .limit(1);

  await db
    .update(expensePolicies)
    .set({
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.effectiveFrom !== undefined ? { effectiveFrom: p.effectiveFrom } : {}),
      ...(p.notes !== undefined ? { notes: p.notes ?? null } : {}),
      ...(p.sourceAttachmentId !== undefined ? { sourceAttachmentId: p.sourceAttachmentId ?? null } : {}),
      updatedAt: new Date(),
      updatedById: user.id,
    })
    .where(eq(expensePolicies.id, p.policyId));

  await audit(user.id, "expense_policy.draft_updated", p.policyId, before[0] ?? null, p);
  refresh();
  return okVoid("Saved.");
}

/* ---------------------------------------------------------------- the rules */

const ruleSchema = z.object({
  policyId: z.string(),
  ruleId: z.string().nullish(),
  kind: z.string(),
  scopeKey: z.string().default(""),
  grade: z.string().nullish(),
  cityClass: z.string().nullish(),
  value: z.record(z.string(), z.unknown()),
  sequence: z.number().int().min(0).default(0),
});

/**
 * Set one rule. The same door for a new one and a change to an existing one,
 * because they are the same act and two doors is two sets of validation.
 */
export async function saveRule(input: unknown): Promise<Result<{ ruleId: string }>> {
  const user = await author();
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return fail("That rule cannot be saved.", "validation");
  const p = parsed.data;

  const guard = await editableDraft(p.policyId);
  if (!guard.ok) return guard.value;

  const draft: RuleDraft = {
    kind: p.kind,
    scopeKey: p.scopeKey,
    grade: p.grade ?? null,
    cityClass: p.cityClass ?? null,
    value: p.value,
  };
  /* The same validation the form ran. A form is not a permission, and this is
     the only copy that cannot be skipped by posting to the URL. */
  const errors = validateRule(draft);
  if (errors.length) return fail("That rule is not complete.", "validation", errors);

  const spec = ruleSpec(p.kind)!;
  const scopeKey = spec.scope === "none" ? "" : p.scopeKey;

  const values = {
    policyId: p.policyId,
    kind: p.kind,
    scopeKey,
    grade: draft.grade,
    cityClass: draft.cityClass,
    valueJson: p.value,
    sequence: p.sequence,
  };

  if (p.ruleId) {
    await db.update(expensePolicyRules).set(values).where(eq(expensePolicyRules.id, p.ruleId));
    await audit(user.id, "expense_policy.rule_updated", p.ruleId, null, values);
    refresh();
    return ok({ ruleId: p.ruleId }, "Rule saved.");
  }

  const id = newId("xrule");
  try {
    await db.insert(expensePolicyRules).values({ id, ...values });
  } catch {
    return fail(
      "This version already has a rule saying that, for the same people and the same place. Change the one that is there rather than adding a second — two answers to one question is a policy nobody can verify.",
      "duplicate",
    );
  }
  await audit(user.id, "expense_policy.rule_added", id, null, values);
  refresh();
  return ok({ ruleId: id }, "Rule added.");
}

export async function deleteRule(input: unknown): Promise<Result> {
  const user = await author();
  const parsed = z.object({ policyId: z.string(), ruleId: z.string() }).safeParse(input);
  if (!parsed.success) return fail("That rule cannot be removed.", "validation");

  const guard = await editableDraft(parsed.data.policyId);
  if (!guard.ok) return guard.value;

  const [before] = await db
    .select()
    .from(expensePolicyRules)
    .where(eq(expensePolicyRules.id, parsed.data.ruleId))
    .limit(1);

  await db
    .delete(expensePolicyRules)
    .where(
      and(
        eq(expensePolicyRules.id, parsed.data.ruleId),
        eq(expensePolicyRules.policyId, parsed.data.policyId),
      ),
    );

  await audit(user.id, "expense_policy.rule_removed", parsed.data.ruleId, before ?? null, null);
  refresh();
  return okVoid("Rule removed.");
}

/* ------------------------------------------------------------- publishing */

/**
 * What is wrong with a draft, in the words somebody would use.
 *
 * Run before publishing AND shown on the screen while the draft is being
 * built, so the list somebody is working through is the same list that will
 * refuse them. A policy that says nothing about how a kilometre is paid is not
 * a policy, and the day to find that out is not the day it goes live.
 */
export async function policyReadiness(policyId: string): Promise<{
  problems: string[];
  warnings: string[];
}> {
  const detail = await readPolicy(policyId, await today());
  if (!detail) return { problems: ["There is no policy version with that id."], warnings: [] };

  const problems: string[] = [];
  const warnings: string[] = [];
  const kinds = new Set(detail.rules.map((r) => r.kind));

  if (detail.rules.length === 0) {
    problems.push("This version has no rules at all, so it would pay nothing to anybody.");
  }
  if (!kinds.has("per_km") && !kinds.has("actuals")) {
    problems.push("Nothing here says how travel is paid — add a rate per kilometre, or a mode reimbursed at actuals.");
  }
  if (!kinds.has("approval_route")) {
    problems.push("Nothing here says who decides a claim, so every day would wait for somebody with no rule saying who.");
  }
  if (detail.unreadableCount > 0) {
    problems.push(
      `${detail.unreadableCount} rule${detail.unreadableCount === 1 ? " is" : "s are"} of a kind this release cannot read. Publishing a version whose rules it cannot show you is not something to do.`,
    );
  }

  const meals = detail.rules.filter((r) => r.kind === "meal_rate").map((r) => r.scopeKey);
  const entitlements = detail.rules.filter((r) => r.kind === "meal_entitlement").map((r) => r.scopeKey);
  for (const meal of meals) {
    if (!entitlements.includes(meal)) {
      warnings.push(`${meal} has an amount but nothing saying when it is earned, so it will never be paid.`);
    }
  }
  for (const meal of entitlements) {
    if (!meals.includes(meal)) {
      warnings.push(`${meal} says when it is earned but has no amount, so it is worth nothing.`);
    }
  }
  if (kinds.has("dormitory") && !kinds.has("meal_rate")) {
    warnings.push("There is a dormitory rule and no meal amounts. Check that is what you mean.");
  }
  if (!kinds.has("proof_threshold")) {
    warnings.push("No claim on this policy will ever require a bill.");
  }
  if (!kinds.has("lodging")) {
    warnings.push("Nothing here says what a hotel night may cost, so a hotel claim will be paid in full.");
  }
  if (!detail.policy.sourceAttachmentId) {
    warnings.push("The document this was typed from is not attached. Attaching it is what lets anybody check these figures later.");
  }

  return { problems, warnings };
}

const publishSchema = z.object({
  policyId: z.string(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Typed back by the publisher. Publishing pays money on these numbers. */
  confirmVersionNo: z.number().int().min(1),
});

/**
 * Put a version into force.
 *
 * Admin only. The previous version's open end is closed the day before this
 * one starts, in the SAME transaction — the exclusion constraint refuses two
 * published versions covering one date, so doing it in two steps would fail
 * halfway and leave the book with either two policies or none.
 */
export async function publishPolicy(input: unknown): Promise<Result<{ versionNo: number }>> {
  await requireCapability("expense.policy.publish");
  const user = await requireUser();

  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) return fail("That version cannot be published.", "validation");
  const p = parsed.data;

  const [policy] = await db
    .select()
    .from(expensePolicies)
    .where(eq(expensePolicies.id, p.policyId))
    .limit(1);
  if (!policy) return fail("There is no policy version with that id.", "not_found");
  if (policy.status !== "draft") {
    return fail(`Version ${policy.versionNo} is already ${policy.status}.`, "rule_violation");
  }
  if (policy.versionNo !== p.confirmVersionNo) {
    return fail(
      "The version number typed back does not match the one being published. Publishing pays money on these figures, so it is asked for deliberately.",
      "validation",
      [{ field: "confirmVersionNo", message: `This is version ${policy.versionNo}.` }],
    );
  }

  const readiness = await policyReadiness(p.policyId);
  if (readiness.problems.length) {
    return fail(readiness.problems[0]!, "rule_violation");
  }

  const previous = await currentlyInForce(p.effectiveFrom);
  if (previous && previous.effectiveFrom >= p.effectiveFrom) {
    return fail(
      `Version ${previous.versionNo} already starts on ${previous.effectiveFrom}. A new version has to begin after the one it replaces, or there is a day two policies both claim.`,
      "conflict",
    );
  }

  try {
    await db.transaction(async (tx) => {
      if (previous) {
        await tx.execute(sql`
          update expense_policies
             set effective_to = (${p.effectiveFrom}::date - interval '1 day')::date,
                 status = 'superseded',
                 superseded_by_policy_id = ${p.policyId},
                 updated_at = now(),
                 updated_by_id = ${user.id}
           where id = ${previous.id}
        `);
      }
      await tx.execute(sql`
        update expense_policies
           set status = 'published',
               effective_from = ${p.effectiveFrom}::date,
               published_at = now(),
               published_by_id = ${user.id},
               updated_at = now(),
               updated_by_id = ${user.id}
         where id = ${p.policyId}
      `);
    });
  } catch (e) {
    return fail(
      `Publishing was refused because it would leave two policies in force on one date. ${e instanceof Error ? e.message : ""}`.trim(),
      "conflict",
    );
  }

  await audit(user.id, "expense_policy.published", p.policyId, { previous }, {
    versionNo: policy.versionNo,
    effectiveFrom: p.effectiveFrom,
  });
  refresh();
  return ok(
    { versionNo: policy.versionNo },
    previous
      ? `Version ${policy.versionNo} is in force from ${p.effectiveFrom}. Version ${previous.versionNo} now ends the day before, and every expense dated inside it is still worked out on it.`
      : `Version ${policy.versionNo} is in force from ${p.effectiveFrom}.`,
  );
}

export async function archiveDraft(input: unknown): Promise<Result> {
  const user = await author();
  const parsed = z.object({ policyId: z.string() }).safeParse(input);
  if (!parsed.success) return fail("That draft cannot be archived.", "validation");

  const guard = await editableDraft(parsed.data.policyId);
  if (!guard.ok) return guard.value;

  await db
    .update(expensePolicies)
    .set({ status: "archived", updatedAt: new Date(), updatedById: user.id })
    .where(eq(expensePolicies.id, parsed.data.policyId));

  await audit(user.id, "expense_policy.draft_archived", parsed.data.policyId, guard.row, null);
  refresh();
  return okVoid("Draft archived. Nothing was deleted — it is still readable.");
}

/* ------------------------------------------------------ grades and cities */

export async function saveGradeMapping(input: unknown): Promise<Result> {
  const user = await author();
  const parsed = z
    .object({ position: z.string().trim().min(1).max(200), gradeId: z.string() })
    .safeParse(input);
  if (!parsed.success) return fail("That mapping cannot be saved.", "validation");

  const key = normaliseKey(parsed.data.position);
  const [grade] = await db
    .select({ id: expenseGrades.id, label: expenseGrades.label })
    .from(expenseGrades)
    .where(eq(expenseGrades.id, parsed.data.gradeId))
    .limit(1);
  if (!grade) return fail("There is no grade with that id.", "not_found");

  await db
    .insert(expenseGradeMap)
    .values({
      id: newId("xgmap"),
      positionNormalised: key,
      positionRaw: parsed.data.position,
      gradeId: grade.id,
      updatedById: user.id,
    })
    .onConflictDoUpdate({
      target: expenseGradeMap.positionNormalised,
      set: { gradeId: grade.id, positionRaw: parsed.data.position, updatedById: user.id },
    });

  await audit(user.id, "expense_policy.grade_mapped", key, null, { position: parsed.data.position, grade: grade.label });
  refresh();
  return okVoid(`Anybody HRMS calls “${parsed.data.position}” is now ${grade.label}.`);
}

export async function saveCityClass(input: unknown): Promise<Result> {
  const user = await author();
  const parsed = z
    .object({
      city: z.string().trim().min(1).max(200),
      cityClass: z.enum(["metro", "tier1", "tier2", "other"]),
    })
    .safeParse(input);
  if (!parsed.success) return fail("That city cannot be classified.", "validation");

  const key = normaliseKey(parsed.data.city);
  await db
    .insert(expenseCityClasses)
    .values({
      id: newId("xcity"),
      cityNormalised: key,
      cityRaw: parsed.data.city,
      cityClass: parsed.data.cityClass,
      updatedById: user.id,
    })
    .onConflictDoUpdate({
      target: expenseCityClasses.cityNormalised,
      set: { cityClass: parsed.data.cityClass, cityRaw: parsed.data.city, updatedById: user.id },
    });

  await audit(user.id, "expense_policy.city_classified", key, null, parsed.data);
  refresh();
  return okVoid(`${parsed.data.city} is a ${parsed.data.cityClass} city.`);
}

export async function removeCityClass(input: unknown): Promise<Result> {
  const user = await author();
  const parsed = z.object({ id: z.string() }).safeParse(input);
  if (!parsed.success) return fail("That city cannot be removed.", "validation");
  await db.delete(expenseCityClasses).where(eq(expenseCityClasses.id, parsed.data.id));
  await audit(user.id, "expense_policy.city_unclassified", parsed.data.id, null, null);
  refresh();
  return okVoid("Removed. That city now falls to the policy's residual rule.");
}


/* ------------------------------------------------------------- §N simulate */

/**
 * What a draft would have cost, over days that really happened.
 *
 * A READ behind a write capability, which is unusual and deliberate: it
 * replays every salesman's real spending, so it answers "what does each of
 * them cost" as a side effect. That is a policy author's question and not
 * everybody's.
 *
 * It writes nothing. The engine is pure and this hands it stored facts with a
 * different policy — there is no version of this that could modify a day.
 */
export async function simulateDraft(input: unknown) {
  await requireCapability("expense.policy.write");
  const parsed = z
    .object({
      policyId: z.string(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .safeParse(input);
  if (!parsed.success) return fail("That window cannot be simulated.", "validation");
  if (parsed.data.to < parsed.data.from) {
    return fail("The window ends before it begins.", "validation");
  }

  const { simulatePolicy } = await import("@/lib/services/expense-simulator-service");
  const result = await simulatePolicy(parsed.data.policyId, parsed.data.from, parsed.data.to);
  if ("error" in result) return fail(result.error, "not_found");
  return ok(result);
}
