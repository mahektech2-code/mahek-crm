import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { isPlatformAdmin, levelInApp } from "@/lib/access-control";
import { salesGateRefusal } from "@/lib/sales-gate";

/* ---------------------------------------------------------------------------
 * What the CRM, Accounts, leads and Sales Dashboard impact sources share: the
 * confirm word, plurals, dropping empty groups, and the one question several
 * of them ask — whose phone holds this shop.
 * ------------------------------------------------------------------------- */

/** The record's own name where somebody can type it, the verb in capitals where not. */
export function word(name: string | null | undefined, verb: string): string {
  const n = (name ?? "").trim().replace(/\s+/g, " ");
  return n && n.length <= 40 ? n : verb.toUpperCase();
}

/** "1 bill" / "3 bills". */
export const many = (n: number, one: string, more = `${one}s`) => (n === 1 ? one : more);

/**
 * Only the groups that hold something. A kept group at zero over a record
 * with nothing of that kind reads as though there were some, so each source
 * drops its empty groups rather than leaning on the registry's filter, which
 * keeps every "kept" group.
 */
export function present<T extends { count: number }>(items: T[]): T[] {
  return items.filter((i) => i.count > 0);
}

/** A list of ids for an `in (…)`. */
export const idList = (ids: readonly string[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

/**
 * WHOSE PHONE HOLDS THESE SHOPS: anybody sitting in one of their seats with a
 * handset bound. A customer row reaches a handset through its owner's book and
 * the seats beside it, so a change to the row is a change on those phones at
 * their next sync.
 */
export async function phonesHolding(customerIds: readonly string[]): Promise<string[]> {
  if (!customerIds.length) return [];
  const rows = await db.execute<{ name: string }>(sql`
    select distinct u.name
      from customers c
      join users u on u.id in (c.owner_id, c.sales_am_id, c.lead_manager_id, c.back_office_am_id, c.relationship_owner_id)
     where c.id in (${idList(customerIds)})
       and exists (select 1 from mbos_devices d where d.user_id = u.id and d.active)
     order by u.name`);
  return rows.map((r) => r.name);
}

/**
 * The Sales Dashboard's own gate — the grant, the level on it where the act
 * is a decision, and the module the act belongs to — asked the way
 * `requireSalesAccess` asks it in `actions/sales.ts`, which a "use server"
 * file cannot export. Throws to refuse, as the registry expects.
 */
export async function salesGate(modules: readonly string[], manager = false): Promise<void> {
  const user = await requireUser();
  const [level, platformAdmin, held] = await Promise.all([
    levelInApp(user, "sales"),
    isPlatformAdmin(user),
    Promise.all(modules.map((k) => canOpenModule(user.id, k))),
  ]);
  const refusal = salesGateRefusal({
    level,
    platformAdmin,
    needManager: manager,
    modulesAsked: modules,
    modulesHeld: modules.filter((_, i) => held[i]),
  });
  if (refusal) throw Object.assign(new Error(refusal), { name: "NotPermittedError" });
}
