import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, users, type User } from "@/db/schema";
import { requireUser } from "./auth";
import { getScope as getScopePreference } from "./scope";

/* ---------------------------------------------------------------------------
 * §8 Access control.
 *
 * Scope is resolved once per request and passed into every query as a
 * parameter. Scoping inside request handlers is how a single missed check
 * leaks another telecaller's book.
 * ------------------------------------------------------------------------- */

export type DataScope =
  | { kind: "own"; userIds: string[] }
  | { kind: "team"; userIds: string[] }
  | { kind: "all"; userIds: null };

export type RequestScope = {
  user: User;
  role: "telecaller" | "manager" | "admin";
  scope: DataScope;
};

/**
 * Resolved once per request. A telecaller always sees their own book — the
 * preference cookie cannot widen it. A manager sees their reports, and an
 * admin sees everything.
 */
export const resolveScope = cache(
  async function resolveScope(): Promise<RequestScope> {
    const user = await requireUser();

    if (user.role === "telecaller") {
      return {
        user,
        role: "telecaller",
        scope: { kind: "own", userIds: [user.id] },
      };
    }

    if (user.role === "admin") {
      return { user, role: "admin", scope: { kind: "all", userIds: null } };
    }

    // A manager may deliberately narrow to their own book.
    const preference = await getScopePreference(user);
    if (preference === "mine") {
      return {
        user,
        role: "manager",
        scope: { kind: "own", userIds: [user.id] },
      };
    }

    const reports = await db
      .select({ id: users.id })
      .from(users)
      .where(or(eq(users.reportsToId, user.id), eq(users.id, user.id)));

    return {
      user,
      role: "manager",
      scope: { kind: "team", userIds: reports.map((r) => r.id) },
    };
  },
);

/** The user ids a query may read, or null for unrestricted. */
export function scopedUserIds(scope: DataScope): string[] | null {
  return scope.kind === "all" ? null : scope.userIds;
}

/**
 * Whose book a customer record sits in — the ONE definition, so no query can
 * quietly disagree with another about what "mine" means.
 *
 * A lead answers to its owner. A customer answers to its sales account
 * manager, falling back to the owner while the field is unset, so a record
 * mid-migration is never orphaned out of everybody's list.
 */
export function assignedUserId(c: {
  kind: "lead" | "customer";
  ownerId: string | null;
  salesAmId: string | null;
}): string | null {
  return c.kind === "lead" ? c.ownerId : (c.salesAmId ?? c.ownerId);
}

/**
 * The same rule as SQL, for scoped list queries. Written out rather than built
 * from Drizzle column refs because these run inside correlated subqueries,
 * where a bare "owner_id" binds to the wrong table.
 */
export const ASSIGNED_TO_SQL = sql`
  case when customers.kind = 'lead'
       then customers.owner_id
       else coalesce(customers.sales_am_id, customers.owner_id)
  end`;

/* -------------------------------------------------------------- permissions */

export const CAPABILITIES = [
  "customer.read",
  "customer.write",
  "customer.export",
  "customer.deactivate",
  "call.log",
  "order.capture",
  "reminder.write",
  "target.set",
  "target.shortfall",
  "complaint.resolve",
  "whatsapp.bulk",
  "whatsapp.template.write",
  "team.report",
  "config.write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** §8's matrix, as data. Telecallers get everything not listed here. */
const MANAGER_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "customer.export",
  "customer.deactivate",
  "target.set",
  "target.shortfall",
  "complaint.resolve",
  "whatsapp.bulk",
  "whatsapp.template.write",
  "team.report",
  "config.write",
]);

export function can(role: string, capability: Capability): boolean {
  if (role === "admin" || role === "manager") return true;
  return !MANAGER_ONLY.has(capability);
}

export class NotPermittedError extends Error {
  readonly capability: Capability;
  readonly requiredRole = "manager";
  constructor(capability: Capability) {
    // Names the required role rather than pretending the resource is absent —
    // the interface shows locked-but-visible controls, and the backend should
    // tell the same story.
    super(
      `That is a manager action. "${capability}" requires the manager role.`,
    );
    this.name = "NotPermittedError";
    this.capability = capability;
  }
}

/** Throws unless the caller holds the capability, and records every denial. */
export async function requireCapability(
  capability: Capability,
): Promise<RequestScope> {
  const ctx = await resolveScope();
  if (can(ctx.role, capability)) return ctx;

  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId: ctx.user.id,
    action: "access.denied",
    entityType: "capability",
    entityId: capability,
    afterState: { role: ctx.role, capability } as never,
  });

  throw new NotPermittedError(capability);
}

/** Non-throwing form, for shaping a response rather than aborting. */
export async function checkCapability(capability: Capability) {
  const ctx = await resolveScope();
  return { allowed: can(ctx.role, capability), ctx };
}

/** Guard for a single customer, used by detail routes. */
export async function assertCustomerInScope(ownerId: string | null) {
  const { scope } = await resolveScope();
  const ids = scopedUserIds(scope);
  if (ids === null) return;
  if (!ownerId || !ids.includes(ownerId)) {
    throw new NotPermittedError("customer.read");
  }
}

export async function userIdsInScope(): Promise<string[] | null> {
  const { scope } = await resolveScope();
  return scopedUserIds(scope);
}

export async function usersByIds(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(users).where(inArray(users.id, ids));
}
