import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { asc, desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { lockerAudit } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * THE LOCKER'S AUDIT WRITER — spec §9. Append-only (a trigger refuses UPDATE
 * and DELETE; see drizzle/0330_locker.sql), hash-chained (each row's hash
 * covers the previous row's), and never a secret value.
 *
 * Writes are serialised with a transaction-scoped advisory lock so two
 * concurrent writers cannot both chain onto the same predecessor and fork
 * the chain. Callers pass their own transaction where the audit row must
 * stand or fall with the change (E7: a reveal whose audit write fails, fails).
 * ------------------------------------------------------------------------- */

type Exec = Pick<typeof db, "execute" | "select" | "insert">;

export type AuditInput = {
  actorId: string | null;
  actorName: string;
  action: string;
  entityType?: string;
  entityId?: string;
  entityTitle?: string;
  summary: string;
  reason?: string | null;
  approvedById?: string | null;
  detail?: Record<string, unknown>;
  security?: boolean;
};

const GENESIS = "0".repeat(64);
const LOCK = 7_244_310; /* any constant: the Locker's audit chain */

function rowHash(prev: string, r: { at: string; actorId: string | null; action: string; entityType: string; entityId: string; summary: string; reason: string | null; detail: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([prev, r.at, r.actorId, r.action, r.entityType, r.entityId, r.summary, r.reason, r.detail]))
    .digest("hex");
}

async function requestMeta(): Promise<{ ip: string | null; ua: string | null }> {
  try {
    const h = await headers();
    return { ip: (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip"), ua: h.get("user-agent") };
  } catch {
    return { ip: null, ua: null };
  }
}

export async function lockerAuditTx(tx: Exec, input: AuditInput): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`);
  const [last] = await tx.select({ hash: lockerAudit.hash }).from(lockerAudit).orderBy(desc(lockerAudit.seq)).limit(1);
  const prev = last?.hash ?? GENESIS;
  const at = new Date().toISOString();
  const r = {
    at,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType ?? "",
    entityId: input.entityId ?? "",
    summary: input.summary,
    reason: input.reason ?? null,
    detail: input.detail ?? {},
  };
  const meta = await requestMeta();
  await tx.insert(lockerAudit).values({
    at: new Date(at),
    actorId: input.actorId,
    actorName: input.actorName,
    action: input.action,
    entityType: r.entityType,
    entityId: r.entityId,
    entityTitle: input.entityTitle ?? "",
    summary: input.summary,
    reason: r.reason,
    approvedById: input.approvedById ?? null,
    detail: r.detail,
    security: !!input.security,
    ip: meta.ip,
    userAgent: meta.ua,
    prevHash: prev,
    hash: rowHash(prev, r),
  });
}

/** Audit outside a caller's transaction. */
export async function lockerAudit_(input: AuditInput): Promise<void> {
  await db.transaction((tx) => lockerAuditTx(tx as unknown as Exec, input));
}
export { lockerAudit_ as writeLockerAudit };

/**
 * Walk the chain and say where it breaks: a row whose hash does not match its
 * contents was altered; a row whose prev_hash does not match its predecessor
 * means one was removed between them.
 */
export async function verifyAuditChain(): Promise<{ ok: true; rows: number } | { ok: false; rows: number; brokenAt: number; why: string }> {
  const rows = await db.select().from(lockerAudit).orderBy(asc(lockerAudit.seq));
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prevHash !== prev) return { ok: false, rows: rows.length, brokenAt: r.seq, why: "A row before this one was removed or altered." };
    const h = rowHash(prev, { at: r.at.toISOString(), actorId: r.actorId, action: r.action, entityType: r.entityType, entityId: r.entityId, summary: r.summary, reason: r.reason, detail: r.detail });
    if (h !== r.hash) return { ok: false, rows: rows.length, brokenAt: r.seq, why: "This row was altered after it was written." };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length };
}
