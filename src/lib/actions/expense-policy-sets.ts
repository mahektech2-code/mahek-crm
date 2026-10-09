"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  expensePolicyAssignments,
  expensePolicySetRevisions,
  expensePolicySets,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCapability } from "@/lib/access-control";
import { STANDARD_DEFAULTS_VERSION, STANDARD_GUIDELINES, STANDARD_POLICY } from "@/lib/expense-policy-standard";
import {
  MAX_GUIDELINE_CHARS,
  MAX_GUIDELINES,
  checkRules,
  readGuidelines,
  readStoredRules,
  ruleToDraft,
  type RuleDraft,
} from "@/lib/expense-policy-sets";
import { daysStampedWith, ensureStandardSet, readPolicySet } from "@/lib/services/expense-policy-set-service";
import { ensurePolicyRow } from "@/lib/services/expense-policy-service";
import { repriceRecentExpenseDays, writeHometown } from "@/lib/services/hometown-service";
import { notifyUsers } from "@/lib/notify";
import { err as fail, ok, okVoid, type Result } from "@/lib/result";
import { ADMIN } from "@/lib/admin-routes";

/* ---------------------------------------------------------------------------
 * Writing named expense policies, and putting people on them.
 *
 * `expense.policy.write` on every path — accounts' and admin's, never a
 * manager's, because a manager may not author what his own team's travelling
 * is allowed to cost. Checked here, not by hiding a button: a server action is
 * a URL.
 *
 * A save takes the WHOLE rule list and the revision it was edited from. A
 * different revision on the row means somebody else saved in between, and the
 * save is refused rather than silently overwriting their change.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function author() {
  await requireCapability("expense.policy.write");
  return requireUser();
}

async function audit(userId: string, action: string, entityId: string | null, before: unknown, after: unknown) {
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

function refresh(setId?: string) {
  try {
    revalidatePath(ADMIN.expensePolicy());
    if (setId) revalidatePath(ADMIN.expensePolicy(setId));
    revalidatePath("/sales/expense-policy");
  } catch {
    /* No request scope — nothing cached to drop. */
  }
}

const repriceRecent = repriceRecentExpenseDays;

/** Everybody a policy's change reaches: its members, or — for standard — everybody on no other active policy. */
async function peopleOn(setId: string, isStandard: boolean): Promise<string[]> {
  const rows = isStandard
    ? await db.execute<{ id: string }>(sql`
        select u.id from users u
         where u.active
           and exists (select 1 from app_access g where g.user_id = u.id and g.app = 'field')
           and not exists (
             select 1 from expense_policy_assignments a
               join expense_policy_sets s on s.id = a.set_id and s.active
              where a.user_id = u.id)
      `)
    : await db.execute<{ id: string }>(
        sql`select user_id as id from expense_policy_assignments where set_id = ${setId}`,
      );
  return rows.map((r) => r.id);
}

async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
  const [row] = await db.execute<{ id: string }>(sql`
    select id from expense_policy_sets
     where lower(name) = lower(${name.trim()}) ${exceptId ? sql`and id <> ${exceptId}` : sql``}
     limit 1
  `);
  return !!row;
}

const nameSchema = z.string().trim().min(2, "Give the policy a name.").max(80, "Keep the name under 80 characters.");
const descriptionSchema = z
  .string()
  .trim()
  .max(500, "Keep the description under 500 characters.")
  .nullable()
  .optional();

/* ------------------------------------------------------------- create */

const createSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
  /** Copy the rules of this policy. Omitted copies the standard one; `blank` starts empty. */
  fromId: z.string().optional(),
});

export async function createPolicySet(input: z.input<typeof createSchema>): Promise<Result<{ id: string }>> {
  const user = await author();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "That is not a policy.", "validation");
  const { name, description, fromId } = parsed.data;

  await ensureStandardSet();
  if (await nameTaken(name))
    return fail(`There is already a policy called "${name}".`, "duplicate", [
      { field: "name", message: "That name is taken." },
    ]);

  let rules: unknown[] = [];
  let guidelines: string[] = [];
  let clonedFromId: string | null = null;
  if (fromId !== "blank") {
    const source = await readPolicySet(fromId ?? STANDARD_POLICY.id);
    if (!source) return fail("The policy to copy from no longer exists.", "not_found");
    rules = source.rules;
    guidelines = source.guidelines;
    clonedFromId = source.id;
  }

  const id = newId("xpol");
  await db.transaction(async (tx) => {
    await tx.insert(expensePolicySets).values({
      id,
      name,
      description: description || null,
      isStandard: false,
      active: true,
      rules,
      guidelines,
      revision: 1,
      clonedFromId,
      createdById: user.id,
      updatedById: user.id,
    });
    await tx.insert(expensePolicySetRevisions).values({
      id: newId("xpsr"),
      setId: id,
      revision: 1,
      name,
      description: description || null,
      rules,
      guidelines,
      note: clonedFromId ? "Created as a copy." : "Created empty.",
      createdById: user.id,
    });
  });
  await ensurePolicyRow(id);
  await audit(user.id, "expense_policy.set.create", id, null, {
    name,
    clonedFromId,
    ruleCount: rules.length,
  });
  refresh();
  return ok({ id }, `"${name}" created.`);
}

/** Duplicate — a create from another policy, named "Copy of …" unless a name is given. */
export async function duplicatePolicySet(input: { id: string; name?: string }): Promise<Result<{ id: string }>> {
  await author();
  const source = await readPolicySet(input.id);
  if (!source) return fail("That policy no longer exists.", "not_found");
  let name = input.name?.trim() || `Copy of ${source.name}`;
  for (let n = 2; !input.name && (await nameTaken(name)); n++) name = `Copy of ${source.name} (${n})`;
  return createPolicySet({
    name: name.slice(0, 80),
    description: source.description,
    fromId: source.id,
  });
}

/* --------------------------------------------------------------- save */

const draftSchema = z.object({
  kind: z.string(),
  scopeKey: z.string(),
  grade: z.string().nullable(),
  cityClass: z.string().nullable(),
  value: z.record(z.string(), z.unknown()),
});

const saveSchema = z.object({
  id: z.string(),
  name: nameSchema,
  description: descriptionSchema,
  rules: z.array(draftSchema).max(300, "A policy of more than 300 rules is a policy nobody can read."),
  /** The policy's written lines. Omitted keeps the ones it has. */
  guidelines: z
    .array(z.string().trim().max(MAX_GUIDELINE_CHARS, `A guideline is at most ${MAX_GUIDELINE_CHARS} characters.`))
    .max(MAX_GUIDELINES, `A policy carries at most ${MAX_GUIDELINES} guidelines.`)
    .optional(),
  /** Set when the save puts the standard policy back on the shipped figures. */
  defaultsVersion: z.number().int().optional(),
  expectedRevision: z.number().int(),
  note: z.string().trim().max(300).nullable().optional(),
});

export async function savePolicySet(input: z.input<typeof saveSchema>): Promise<Result<{ revision: number }>> {
  const user = await author();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "That is not a policy.", "validation");
  const { id, name, description, rules: drafts, expectedRevision, note, defaultsVersion } = parsed.data;

  const current = await readPolicySet(id);
  if (!current) return fail("That policy no longer exists.", "not_found");
  if (current.revision !== expectedRevision) {
    return fail(
      `${current.updatedByName ?? "Somebody"} saved this policy while you were editing it. Reload to see their change, then make yours again.`,
      "conflict",
    );
  }
  if (await nameTaken(name, id))
    return fail(`There is already a policy called "${name}".`, "duplicate", [
      { field: "name", message: "That name is taken." },
    ]);

  const { rules, errors } = checkRules(drafts as RuleDraft[]);
  if (errors.length) {
    return fail(
      `${errors.length === 1 ? "One rule needs" : `${errors.length} rules need`} fixing before this can be saved.`,
      "validation",
      errors.map((e) => ({
        field: `rules.${e.index}.${e.field}`,
        message: e.message,
      })),
    );
  }

  const guidelines = parsed.data.guidelines ? readGuidelines(parsed.data.guidelines) : current.guidelines;
  const revision = current.revision + 1;
  try {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(expensePolicySets)
        .set({
          name,
          description: description || null,
          rules,
          guidelines,
          revision,
          ...(defaultsVersion ? { defaultsVersion } : {}),
          updatedById: user.id,
          updatedAt: new Date(),
        })
        .where(and(eq(expensePolicySets.id, id), eq(expensePolicySets.revision, expectedRevision)))
        .returning({ id: expensePolicySets.id });
      if (updated.length === 0) throw new Error("Somebody else saved this policy a moment ago. Reload and try again.");
      await tx.insert(expensePolicySetRevisions).values({
        id: newId("xpsr"),
        setId: id,
        revision,
        name,
        description: description || null,
        rules,
        guidelines,
        note: note || null,
        createdById: user.id,
      });
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "The policy could not be saved.", "conflict");
  }

  /* The anchor's title follows the name, so a stamped day reads right. */
  await db.execute(sql`update expense_policies set title = ${name}, updated_at = now() where id = ${id}`);
  await audit(
    user.id,
    "expense_policy.set.save",
    id,
    { name: current.name, revision: current.revision, rules: current.rules, guidelines: current.guidelines },
    { name, revision, rules, guidelines },
  );
  await repriceRecent(await peopleOn(id, current.isStandard));
  refresh(id);
  return ok(
    { revision },
    `Saved — revision ${revision}. It applies from the next day worked out and the next handset sync.`,
  );
}

/* ------------------------------------------------- restore & defaults */

export async function restorePolicyRevision(input: {
  id: string;
  revision: number;
}): Promise<Result<{ revision: number }>> {
  await author();
  const current = await readPolicySet(input.id);
  if (!current) return fail("That policy no longer exists.", "not_found");
  const [snap] = await db
    .select()
    .from(expensePolicySetRevisions)
    .where(and(eq(expensePolicySetRevisions.setId, input.id), eq(expensePolicySetRevisions.revision, input.revision)))
    .limit(1);
  if (!snap) return fail("That revision is not on record.", "not_found");
  const { rules } = readStoredRules(snap.rules);
  return savePolicySet({
    id: current.id,
    name: current.name,
    description: current.description,
    rules: rules.map(ruleToDraft),
    guidelines: readGuidelines(snap.guidelines),
    expectedRevision: current.revision,
    note: `Restored revision ${input.revision}.`,
  });
}

/** Put the standard policy back to the figures it shipped with. */
export async function resetStandardToDefaults(input: {
  expectedRevision: number;
}): Promise<Result<{ revision: number }>> {
  await author();
  await ensureStandardSet();
  const current = await readPolicySet(STANDARD_POLICY.id);
  if (!current) return fail("The standard policy is missing.", "not_found");
  return savePolicySet({
    id: current.id,
    name: current.name,
    description: current.description,
    rules: STANDARD_POLICY.rules.map(ruleToDraft),
    guidelines: [...STANDARD_GUIDELINES],
    defaultsVersion: STANDARD_DEFAULTS_VERSION,
    expectedRevision: input.expectedRevision,
    note: "Reset to the shipped defaults.",
  });
}

/* ---------------------------------------------- switch off, delete */

export async function setPolicySetActive(input: { id: string; active: boolean }): Promise<Result> {
  const user = await author();
  const current = await readPolicySet(input.id);
  if (!current) return fail("That policy no longer exists.", "not_found");
  if (current.isStandard && !input.active) {
    return fail("The standard policy cannot be switched off — it is what everybody falls back to.", "rule_violation");
  }
  if (current.active === input.active) return okVoid();
  await db
    .update(expensePolicySets)
    .set({ active: input.active, updatedById: user.id, updatedAt: new Date() })
    .where(eq(expensePolicySets.id, input.id));
  await audit(
    user.id,
    input.active ? "expense_policy.set.activate" : "expense_policy.set.deactivate",
    input.id,
    { active: current.active },
    { active: input.active },
  );
  await repriceRecent(await peopleOn(input.id, false));
  refresh(input.id);
  return okVoid(
    input.active
      ? `"${current.name}" is on again. Its ${current.memberCount} ${current.memberCount === 1 ? "person is" : "people are"} back on it.`
      : `"${current.name}" is switched off. Its ${current.memberCount} ${current.memberCount === 1 ? "person is" : "people are"} on the standard policy until it is switched back on.`,
  );
}

export async function deletePolicySet(input: { id: string }): Promise<Result> {
  const user = await author();
  const current = await readPolicySet(input.id);
  if (!current) return fail("That policy no longer exists.", "not_found");
  if (current.isStandard) return fail("The standard policy cannot be deleted.", "rule_violation");
  const stamped = await daysStampedWith(input.id);
  if (stamped > 0) {
    return fail(
      `${stamped} expense ${stamped === 1 ? "day was" : "days were"} worked out on this policy, so it is kept as the record of them. Switch it off instead.`,
      "rule_violation",
    );
  }
  const members = await peopleOn(input.id, false);
  await db.transaction(async (tx) => {
    await tx.delete(expensePolicySets).where(eq(expensePolicySets.id, input.id));
    await tx.execute(sql`delete from expense_policies where id = ${input.id} and status = 'archived'`);
  });
  await audit(
    user.id,
    "expense_policy.set.delete",
    input.id,
    { name: current.name, rules: current.rules, members },
    null,
  );
  await repriceRecent(members);
  refresh();
  return okVoid(
    `"${current.name}" deleted.${members.length ? ` ${members.length} ${members.length === 1 ? "person is" : "people are"} back on the standard policy.` : ""}`,
  );
}

/* ------------------------------------------------------------- assign */

const assignSchema = z.object({
  userIds: z.array(z.string()).min(1, "Pick at least one person.").max(1000),
  /** Null puts them back on the standard policy. */
  setId: z.string().nullable(),
  notify: z.boolean().optional(),
});

export async function assignPolicySet(input: z.input<typeof assignSchema>): Promise<Result<{ moved: number }>> {
  const user = await author();
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Nobody to assign.", "validation");
  const { userIds, notify } = parsed.data;
  await ensureStandardSet();

  let target = parsed.data.setId ? await readPolicySet(parsed.data.setId) : null;
  if (parsed.data.setId && !target) return fail("That policy no longer exists.", "not_found");
  if (target?.isStandard) target = null;
  if (target && !target.active)
    return fail(`"${target.name}" is switched off. Switch it on before putting anybody on it.`, "rule_violation");

  const before = await db
    .select({
      userId: expensePolicyAssignments.userId,
      setId: expensePolicyAssignments.setId,
    })
    .from(expensePolicyAssignments)
    .where(inArray(expensePolicyAssignments.userId, userIds));
  const was = new Map(before.map((b) => [b.userId, b.setId]));
  const moving = userIds.filter((u) => (was.get(u) ?? null) !== (target?.id ?? null));
  if (moving.length === 0) return ok({ moved: 0 }, "Nobody moved — they are already on that policy.");

  await db.transaction(async (tx) => {
    if (target) {
      for (const userId of moving) {
        await tx
          .insert(expensePolicyAssignments)
          .values({ userId, setId: target.id, assignedById: user.id })
          .onConflictDoUpdate({
            target: expensePolicyAssignments.userId,
            set: {
              setId: target.id,
              assignedById: user.id,
              assignedAt: new Date(),
            },
          });
      }
    } else {
      await tx.delete(expensePolicyAssignments).where(inArray(expensePolicyAssignments.userId, moving));
    }
  });

  const targetName = target?.name ?? "the standard expense policy";
  await audit(
    user.id,
    "expense_policy.set.assign",
    target?.id ?? STANDARD_POLICY.id,
    Object.fromEntries(moving.map((u) => [u, was.get(u) ?? null])),
    { setId: target?.id ?? null, userIds: moving },
  );
  if (notify !== false) {
    try {
      await notifyUsers(
        moving.map((userId) => ({
          userId,
          title: "Your expense policy changed",
          body: `You are now on ${targetName}. Open Expenses to see what it pays.`,
          kind: "info",
        })),
      );
    } catch {
      /* A bell that could not be written never undoes the assignment. */
    }
  }
  await repriceRecent(moving);
  refresh(target?.id);
  return ok(
    { moved: moving.length },
    `${moving.length} ${moving.length === 1 ? "person" : "people"} moved to ${targetName}.`,
  );
}

/* ----------------------------------------------------------- hometown */

const hometownSchema = z.object({
  userId: z.string().min(1),
  /** A city node of the reviewed place tree. Null clears it, and the day keeps what the handset recorded. */
  placeId: z.string().min(1).nullable(),
});

/**
 * Where a salesman lives, for the policy's "away from his hometown" — the same
 * record the Sales Dashboard's Salesmen screen sets, through the same writer.
 */
export async function setExpenseHometown(input: z.input<typeof hometownSchema>): Promise<Result> {
  const user = await author();
  const parsed = hometownSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "That is not a town.", "validation");
  const result = await writeHometown(user.id, parsed.data.userId, parsed.data.placeId);
  if (result.ok) {
    refresh();
    try {
      revalidatePath("/sales/people");
    } catch {
      /* No request scope. */
    }
  }
  return result;
}
