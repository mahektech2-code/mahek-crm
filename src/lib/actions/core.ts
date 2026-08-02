import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, bills, customers, notifications } from "@/db/schema";
import type { User } from "@/db/schema";

export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string };

export function ok<T>(message?: string, data?: T): ActionResult<T> {
  return { ok: true, message, data };
}

export function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

/** Every write leaves a trail. Managers read it, and it explains the numbers. */
export async function audit(
  user: User | null,
  action: string,
  entity: string,
  entityId?: string | null,
  detail?: string | null,
) {
  await db.insert(auditLog).values({
    id: newId("aud"),
    userId: user?.id ?? null,
    action,
    entity,
    entityId: entityId ?? null,
    detail: detail ?? null,
  });
}

export async function notify(
  userId: string,
  title: string,
  body: string,
  kind = "info",
  href?: string,
) {
  await db.insert(notifications).values({
    id: newId("ntf"),
    userId,
    title,
    body,
    kind,
    href: href ?? null,
  });
}

/**
 * Outstanding is derived from bills, never typed in. Call this after anything
 * that changes a bill or a payment so the customer row cannot drift.
 */
export async function recomputeOutstanding(customerId: string) {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${bills.amount} - ${bills.paid}), 0)::bigint`,
    })
    .from(bills)
    .where(eq(bills.customerId, customerId));

  await db
    .update(customers)
    .set({ outstanding: Number(row?.total ?? 0) })
    .where(eq(customers.id, customerId));
}
