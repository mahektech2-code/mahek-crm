"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { accessTemplates, auditLog, erpUserDesignations } from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { ConsoleNotConfirmedError } from "@/lib/console-confirm";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import { ADMIN } from "@/lib/admin-routes";
import { listAccess } from "@/lib/services/access-service";
import { getErpDesignation } from "@/lib/services/erp-designation-service";
import { applyChange, cleanShape, powerById, shapeFromRow, type AccessTemplateShape, type BulkChange } from "@/lib/access-bulk";
import { setAccess } from "./access";

/* ---------------------------------------------------------------------------
 * ACCESS IN BULK — the console's "give this to these people" and job
 * templates. Every person is saved through `setAccess`, one at a time, with
 * the whole picture `applyChange` worked out for them: so a bulk change obeys
 * every rule a single save does and writes the same audit row per person. A
 * refusal for one person does not stop the others; the result says who moved,
 * who was skipped and why, in words.
 *
 * Platform administrators only, like the dialog.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function actor() {
  try {
    return await requirePlatformAdminUser();
  } catch (e) {
    if (e instanceof ConsoleNotConfirmedError) throw e;
    throw new Error("Only a platform administrator can change access.");
  }
}

async function audit(actorId: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId,
    action,
    entityType,
    entityId,
    actorRole: "admin",
    actorApp: "admin",
    beforeState: (before ?? null) as never,
    afterState: (after ?? null) as never,
  });
}

function refresh() {
  try {
    revalidatePath(ADMIN.home, "layout");
    revalidatePath("/apps");
    revalidatePath("/erp", "layout");
  } catch {
    /* outside a request */
  }
}

export type BulkOutcome = {
  moved: { userId: string; name: string; words: string }[];
  skipped: { userId: string; name: string; why: string }[];
};

async function run(userIds: string[], change: (row: Awaited<ReturnType<typeof listAccess>>[number]) => BulkChange | null, label: string): Promise<Result<BulkOutcome>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return err(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }
  const ids = [...new Set(userIds)];
  if (!ids.length) return fieldErr("people", "Pick at least one person.");
  if (ids.length > 200) return fieldErr("people", "Up to 200 people at a time.");

  const rows = new Map((await listAccess()).map((r) => [r.userId, r]));
  const out: BulkOutcome = { moved: [], skipped: [] };
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      out.skipped.push({ userId: id, name: id, why: "no longer has an account" });
      continue;
    }
    if (!row.active) {
      out.skipped.push({ userId: id, name: row.name, why: "is deactivated" });
      continue;
    }
    const c = change(row);
    if (!c) {
      out.skipped.push({ userId: id, name: row.name, why: "nothing to apply" });
      continue;
    }
    const applied = applyChange(row, c);
    if (!applied.changed) {
      out.skipped.push({ userId: id, name: row.name, why: applied.why });
      continue;
    }
    const res = await setAccess({ ...applied.save });
    if (res.ok) out.moved.push({ userId: id, name: row.name, words: applied.words });
    else out.skipped.push({ userId: id, name: row.name, why: res.error });
  }
  await audit(me.id, "access.bulk", "access", label, null, { label, moved: out.moved.length, skipped: out.skipped.length, people: out.moved.map((m) => `${m.name}: ${m.words}`) });
  refresh();
  return ok(out);
}

/** Give or take away one power, for several people. Granting also ticks the screens the power is used on. */
export async function bulkPower(input: { power: string; on: boolean; userIds: string[]; grantApp?: boolean }): Promise<Result<BulkOutcome>> {
  const p = powerById(input.power);
  if (!p) return err("That power no longer exists.", "not_found");
  return run(input.userIds, () => ({ kind: "power", power: p.id, on: input.on, grantApp: input.grantApp }), `${input.on ? "grant" : "remove"} ${p.id}`);
}

/** Tick or untick one screen, for several people. */
export async function bulkScreen(input: { module: string; on: boolean; userIds: string[]; grantApp?: boolean }): Promise<Result<BulkOutcome>> {
  return run(input.userIds, () => ({ kind: "screen", module: input.module, on: input.on, grantApp: input.grantApp }), `${input.on ? "grant" : "remove"} ${input.module}`);
}

/**
 * Bring EVERY holder of an ERP designation up to it — including the ones
 * customised away from it, whom an edit to the designation leaves alone on
 * purpose. Additive only: whatever extra a customised person holds stays.
 */
export async function syncDesignation(designationId: string): Promise<Result<BulkOutcome>> {
  const d = await getErpDesignation(designationId);
  if (!d) return err("That designation no longer exists.", "not_found");
  const links = await db.select({ userId: erpUserDesignations.userId }).from(erpUserDesignations).where(eq(erpUserDesignations.designationId, designationId));
  const shape: AccessTemplateShape = {
    apps: [{ app: "erp", role: d.level, modules: d.allScreens ? null : d.modules }],
    erpPowers: d.level === "admin" ? [] : d.powers,
    hrmsPowers: [],
    taskPowers: [],
  };
  return run(links.map((l) => l.userId), () => ({ kind: "template", shape }), `sync designation ${d.name}`);
}

/* ------------------------------------------------------------ templates */

export type TemplateInput = { id?: string | null; name: string; description?: string | null; shape: AccessTemplateShape };

export async function saveAccessTemplate(input: TemplateInput): Promise<Result<{ id: string }>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return err(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) return fieldErr("name", "A template needs a name.");
  if (name.length > 60) return fieldErr("name", "Keep the name under 60 characters.");
  const shape = cleanShape(input.shape);
  if (!shape.apps.length) return fieldErr("shape", "A template has to give at least one app.");
  const clash = await db
    .select({ id: accessTemplates.id })
    .from(accessTemplates)
    .where(input.id ? and(sql`lower(${accessTemplates.name}) = lower(${name})`, ne(accessTemplates.id, input.id)) : sql`lower(${accessTemplates.name}) = lower(${name})`)
    .limit(1);
  if (clash.length) return fieldErr("name", "Another template already has that name.");

  const description = input.description?.trim() || null;
  if (input.id) {
    const [before] = await db.select().from(accessTemplates).where(eq(accessTemplates.id, input.id)).limit(1);
    if (!before) return err("That template no longer exists.", "not_found");
    await db.update(accessTemplates).set({ name, description, shape, updatedAt: new Date(), updatedById: me.id }).where(eq(accessTemplates.id, input.id));
    await audit(me.id, "access.template.save", "access_template", input.id, before, { name, description, shape });
    refresh();
    return ok({ id: input.id });
  }
  const id = newId("tpl");
  await db.insert(accessTemplates).values({ id, name, description, shape, updatedById: me.id });
  await audit(me.id, "access.template.create", "access_template", id, null, { name, description, shape });
  refresh();
  return ok({ id });
}

/** A template made from what one person holds today — "everyone like Puja". */
export async function templateFromPerson(input: { userId: string; name: string; description?: string | null }): Promise<Result<{ id: string }>> {
  try {
    await actor();
  } catch (e) {
    return err(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }
  const row = (await listAccess()).find((r) => r.userId === input.userId);
  if (!row) return err("That person no longer has an account.", "not_found");
  if (!row.grants.length) return err(`${row.name} holds no apps to copy.`, "rule_violation");
  return saveAccessTemplate({ name: input.name, description: input.description, shape: shapeFromRow(row) });
}

export async function deleteAccessTemplate(id: string): Promise<Result<undefined>> {
  let me;
  try {
    me = await actor();
  } catch (e) {
    return err(e instanceof Error ? e.message : "Not allowed.", "not_permitted");
  }
  const [before] = await db.select().from(accessTemplates).where(eq(accessTemplates.id, id)).limit(1);
  if (!before) return err("That template no longer exists.", "not_found");
  /* Nothing links to a template — applying one stamps it — so deleting one moves nobody. */
  await db.delete(accessTemplates).where(eq(accessTemplates.id, id));
  await audit(me.id, "access.template.delete", "access_template", id, before, null);
  refresh();
  return okVoid("Template deleted.");
}

/** Apply a template to several people. It only ever widens what they hold. */
export async function applyAccessTemplate(input: { templateId: string; userIds: string[] }): Promise<Result<BulkOutcome>> {
  const [t] = await db.select().from(accessTemplates).where(eq(accessTemplates.id, input.templateId)).limit(1);
  if (!t) return err("That template no longer exists.", "not_found");
  const shape = cleanShape(t.shape);
  return run(input.userIds, () => ({ kind: "template", shape }), `apply template ${t.name}`);
}
