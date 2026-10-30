import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { canOpenModule } from "@/lib/access";

/* ---------------------------------------------------------------------------
 * WHO SITS AT THE PRICE DESK — the people a change waiting for approval, a
 * special price waiting for a decision and a morning check's findings are
 * sent to.
 *
 * `pricelist.manage` is held at both levels of Accounts and of the Founder
 * Dashboard, and narrowed by each app's own Price lists module; a platform
 * administrator holds everything. So: everybody granted Accounts or the
 * Founder Dashboard whose grant reaches its Price lists module, and the
 * platform administrators. Each is linked to the door they would open.
 * ------------------------------------------------------------------------- */

export type DeskPerson = { id: string; name: string; basePath: string };

export async function priceDeskPeople(): Promise<DeskPerson[]> {
  const rows = await db.execute<{ id: string; name: string; apps: string[]; admin: boolean }>(sql`
    select u.id, u.name, coalesce(array_agg(distinct a.app::text) filter (where a.app is not null), '{}') as apps,
           (u.role = 'admin') as admin
      from users u
      left join app_access a on a.user_id = u.id and a.app in ('accounts', 'founder')
     where u.active
     group by u.id, u.name, u.role
    having u.role = 'admin' or count(a.app) > 0
  `);
  const out: DeskPerson[] = [];
  for (const r of rows) {
    const apps = r.apps ?? [];
    if (apps.includes("accounts") && (await canOpenModule(r.id, "accounts.price-lists"))) {
      out.push({ id: r.id, name: r.name, basePath: "/accounts/price-lists" });
    } else if (apps.includes("founder") && (await canOpenModule(r.id, "founder.price-lists"))) {
      out.push({ id: r.id, name: r.name, basePath: "/founder/price-lists" });
    } else if (r.admin) {
      out.push({ id: r.id, name: r.name, basePath: "/accounts/price-lists" });
    }
  }
  return out;
}
