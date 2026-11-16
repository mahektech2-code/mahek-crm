import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, mbosDevices, mbosRemoteItems } from "@/db/schema";
import {
  resolveRemote,
  type Audience,
  type RemoteItem,
  type RemoteKind,
  type RemotePayload,
  type Who,
} from "@/lib/engines/mbos-remote";

/* ---------------------------------------------------------------------------
 * The remote-control channel of the MBOS pull — see `engines/mbos-remote.ts`.
 *
 * IT CANNOT TAKE THE PULL DOWN. Every failure here answers null, the handset
 * keeps what it last had, and every other channel — the configuration the
 * trail reads above all — goes out exactly as it would have. A broken switch
 * is a cosmetic fault; a broken pull is a salesman with an empty book.
 * ------------------------------------------------------------------------- */

export async function allRemoteItems(): Promise<(RemoteItem & { note: string; updatedAt: Date; updatedById: string | null })[]> {
  const rows = await db.select().from(mbosRemoteItems).orderBy(mbosRemoteItems.key);
  return rows.map((r) => ({
    key: r.key,
    kind: r.kind as RemoteKind,
    value: r.value,
    audience: (r.audience ?? {}) as Audience,
    enabled: r.enabled,
    version: r.version,
    note: r.note,
    updatedAt: r.updatedAt,
    updatedById: r.updatedById,
  }));
}

/** What one signed-in handset receives. Null on any failure — see above. */
export async function remoteFor(principal: { user: { id: string }; role: string; deviceId: string }): Promise<RemotePayload | null> {
  try {
    const [device] = await db
      .select({ appVersion: mbosDevices.appVersion })
      .from(mbosDevices)
      .where(eq(mbosDevices.deviceId, principal.deviceId))
      .limit(1);
    const items = await allRemoteItems();
    return resolveRemote(
      items,
      { userId: principal.user.id, role: principal.role, appVersion: device?.appVersion ?? null },
      Date.now(),
    );
  } catch (e) {
    console.warn("[mbos] remote items not sent", e);
    return null;
  }
}

/**
 * The same answer for somebody who is not signed in here — the console's
 * "what does this person's phone get". Their field level, and the build their
 * newest phone last reported.
 */
export async function previewRemoteFor(userId: string): Promise<{ who: Who; payload: RemotePayload } | null> {
  const [grant] = await db
    .select({ role: appAccess.role })
    .from(appAccess)
    .where(and(eq(appAccess.userId, userId), eq(appAccess.app, "field")))
    .limit(1);
  if (!grant) return null;
  const [device] = await db
    .select({ appVersion: mbosDevices.appVersion })
    .from(mbosDevices)
    .where(eq(mbosDevices.userId, userId))
    .orderBy(desc(mbosDevices.lastRequestAt))
    .limit(1);
  const who: Who = { userId, role: grant.role ?? "associate", appVersion: device?.appVersion ?? null };
  return { who, payload: resolveRemote(await allRemoteItems(), who, Date.now()) };
}
