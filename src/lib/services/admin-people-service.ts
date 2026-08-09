import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, customers, users } from "@/db/schema";
import type { AppId } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * The people of MahekOne, read from the database.
 *
 * What replaced a hardcoded array. The console's People section rendered
 * invented names, invented staff codes and invented departments, and its
 * checkboxes never reached the server — convincing enough that somebody would
 * eventually act on it.
 *
 * This returns what the database actually knows and nothing else. Where there
 * was a column for something never stored — a staff code, a department, a role
 * per app when a user has exactly one — the answer is to stop showing the
 * column rather than to keep filling it in.
 * ------------------------------------------------------------------------- */

export type Person = {
  id: string;
  name: string;
  email: string;
  /** The work number. How staff are identified to each other, and a login. */
  phone: string | null;
  role: "telecaller" | "manager" | "accounts" | "admin";
  initials: string;
  active: boolean;
  reportsToId: string | null;
  reportsToName: string | null;
  apps: AppId[];
  /** Customers whose book this account holds. Real work, not a decoration. */
  customerCount: number;
  lastLoginAt: string | null;
  createdAt: string;
};

export async function listPeople(): Promise<Person[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: users.role,
      initials: users.initials,
      active: users.active,
      reportsToId: users.reportsToId,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.name));

  const access = await db
    .select({ userId: appAccess.userId, app: appAccess.app })
    .from(appAccess);

  // One grouped count rather than a query per person: a hundred accounts must
  // not be a hundred round trips to render one table.
  const owned = await db
    .select({
      userId: sql<string>`coalesce(${customers.salesAmId}, ${customers.ownerId})`,
      n: sql<number>`count(*)::int`,
    })
    .from(customers)
    .groupBy(sql`coalesce(${customers.salesAmId}, ${customers.ownerId})`);

  const appsByUser = new Map<string, AppId[]>();
  for (const a of access) {
    const list = appsByUser.get(a.userId) ?? [];
    list.push(a.app as AppId);
    appsByUser.set(a.userId, list);
  }
  const countByUser = new Map(owned.map((o) => [o.userId, Number(o.n)]));
  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    role: r.role as Person["role"],
    initials: r.initials,
    active: r.active,
    reportsToId: r.reportsToId,
    reportsToName: r.reportsToId ? (nameById.get(r.reportsToId) ?? null) : null,
    apps: (appsByUser.get(r.id) ?? []).sort(),
    customerCount: countByUser.get(r.id) ?? 0,
    lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Everyone a telecaller could report to. Used by the edit form. */
export async function listManagers(): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.role, "manager"))
    .orderBy(asc(users.name));
  return rows;
}
