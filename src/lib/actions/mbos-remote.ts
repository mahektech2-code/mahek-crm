"use server";

import { randomUUID } from "node:crypto";
import { eq, inArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { auditLog, mbosRemoteItems, users } from "@/db/schema";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { ADMIN } from "@/lib/admin-routes";
import { err, fromThrown, ok, okVoid, type Result } from "@/lib/result";
import { validateRemoteItem, type Audience, type RemoteKind, type RemotePayload, type Who } from "@/lib/engines/mbos-remote";
import { previewRemoteFor } from "@/lib/services/mbos-remote-service";

/* ---------------------------------------------------------------------------
 * Admin Console → MBOS control. A platform administrator with a recently
 * proved password, like every other console write; every change is audited.
 * What reaches phones is decided by `engines/mbos-remote.ts`, and the same
 * validation runs here before anything is stored — the database CHECKs are the
 * last line, not the first.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function audit(actorId: string, action: string, key: string, after: Record<string, unknown>) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    actorId,
    action,
    entityType: "mbos_remote_item",
    entityId: key,
    actorRole: "admin",
    actorApp: "admin",
    afterState: { key, ...after } as never,
  });
}

export async function saveRemoteItem(input: {
  key: string;
  kind: RemoteKind;
  value: unknown;
  audience: Omit<Audience, "userIds">;
  /** Emails or work numbers, turned into people here. Empty = everybody. */
  people: string[];
  note: string;
  /** The key being edited, when it is an edit. A rename is a delete and an add. */
  originalKey?: string | null;
}): Promise<Result> {
  try {
    const user = await requirePlatformAdminUser();
    const key = input.key.trim();
    const people = await peopleFrom(input.people);
    if (!people.ok) return people;
    const audience = cleanAudience({ ...input.audience, userIds: people.data });
    const errors = validateRemoteItem({ key, kind: input.kind, value: input.value, audience });
    if (errors.length) return err(errors.join(" "));

    await db.transaction(async (tx) => {
      if (input.originalKey && input.originalKey !== key) {
        await tx.delete(mbosRemoteItems).where(eq(mbosRemoteItems.key, input.originalKey));
      }
      await tx
        .insert(mbosRemoteItems)
        .values({
          key,
          kind: input.kind,
          value: input.value as never,
          audience: audience as never,
          note: input.note.trim().slice(0, 500),
          updatedById: user.id,
        })
        .onConflictDoUpdate({
          target: mbosRemoteItems.key,
          set: {
            kind: input.kind,
            value: input.value as never,
            audience: audience as never,
            note: input.note.trim().slice(0, 500),
            version: sql`${mbosRemoteItems.version} + 1`,
            updatedById: user.id,
            updatedAt: new Date(),
          },
        });
    });
    await audit(user.id, "mbos.remote.saved", key, { kind: input.kind, value: input.value, audience });
    revalidatePath(ADMIN.mbosControl);
    return okVoid("Saved. Phones pick it up on their next sync.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function setRemoteItemEnabled(key: string, enabled: boolean): Promise<Result> {
  try {
    const user = await requirePlatformAdminUser();
    const rows = await db
      .update(mbosRemoteItems)
      .set({ enabled, version: sql`${mbosRemoteItems.version} + 1`, updatedById: user.id, updatedAt: new Date() })
      .where(eq(mbosRemoteItems.key, key))
      .returning({ key: mbosRemoteItems.key });
    if (!rows.length) return err("That item no longer exists.", "not_found");
    await audit(user.id, "mbos.remote.switched", key, { enabled });
    revalidatePath(ADMIN.mbosControl);
    return okVoid(enabled ? "Switched on." : "Switched off. Phones go back to what is built in.");
  } catch (e) {
    return fromThrown(e);
  }
}

export async function deleteRemoteItem(key: string): Promise<Result> {
  try {
    const user = await requirePlatformAdminUser();
    await db.delete(mbosRemoteItems).where(eq(mbosRemoteItems.key, key));
    await audit(user.id, "mbos.remote.deleted", key, {});
    revalidatePath(ADMIN.mbosControl);
    return okVoid("Removed. Phones go back to what is built in.");
  } catch (e) {
    return fromThrown(e);
  }
}

/** What one person's phone receives right now, by email or work number. */
export async function previewRemote(who: string): Promise<Result<{ name: string; who: Who; payload: RemotePayload }>> {
  try {
    await requirePlatformAdminUser();
    const q = who.trim().toLowerCase();
    if (!q) return err("Type an email or a work number.");
    const [person] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(sql`lower(${users.email}) = ${q} or ${users.phone} = ${q}`)
      .limit(1);
    if (!person) return err("Nobody has that email or work number.", "not_found");
    const out = await previewRemoteFor(person.id);
    if (!out) return err(`${person.name} does not have Mahek MBOS.`, "not_found");
    return ok({ name: person.name, ...out });
  } catch (e) {
    return fromThrown(e);
  }
}

async function peopleFrom(list: string[]): Promise<Result<string[]>> {
  const wanted = [...new Set(list.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return ok([]);
  const rows = await db
    .select({ id: users.id, email: users.email, phone: users.phone })
    .from(users)
    .where(or(inArray(sql`lower(${users.email})`, wanted), inArray(users.phone, wanted)));
  const missing = wanted.filter((w) => !rows.some((r) => r.email?.toLowerCase() === w || r.phone === w));
  if (missing.length) return err(`Nobody has ${missing.join(", ")}.`);
  return ok(rows.map((r) => r.id));
}

function cleanAudience(a: Audience): Audience {
  const out: Audience = {};
  if (a.roles?.length) out.roles = a.roles.filter((r) => ["associate", "manager", "admin"].includes(r));
  if (a.userIds?.length) out.userIds = [...new Set(a.userIds.map((u) => u.trim()).filter(Boolean))];
  if (a.minVersion?.trim()) out.minVersion = a.minVersion.trim();
  if (a.maxVersion?.trim()) out.maxVersion = a.maxVersion.trim();
  if (a.percent != null && a.percent !== 100) out.percent = a.percent;
  if (out.roles && !out.roles.length) delete out.roles;
  return out;
}
