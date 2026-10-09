import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { ErpPower } from "../powers";

/* ---------------------------------------------------------------------------
 * Telling the people a petty-cash record now waits on. A decision nobody
 * receives is not a decision: an expense submitted for approval reaches the
 * approvers' bells, a handover reaches whoever must confirm it.
 * ------------------------------------------------------------------------- */

/** Everyone who holds the ERP and either `power` or the ERP administrator's level. */
export async function holdersOf(power: ErpPower): Promise<string[]> {
  const rows = (await db.execute(sql`
    select distinct u.id from users u
      join app_access a on a.user_id = u.id and a.app::text = 'erp'
     where u.active
       and (a.role::text = 'admin' or u.role::text = 'admin'
            or exists (select 1 from erp_user_powers p where p.user_id = u.id and p.power = ${power}))`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export async function notifyPetty(
  power: ErpPower | { users: string[] },
  n: { title: string; body: string; view: string; open?: string; exclude?: (string | null | undefined)[]; kind?: "info" | "warn" | "success" },
): Promise<void> {
  try {
    const ids = "users" in (power as object) ? (power as { users: string[] }).users : await holdersOf(power as ErpPower);
    const skip = new Set((n.exclude ?? []).filter(Boolean));
    const to = [...new Set(ids)].filter((id) => !skip.has(id));
    if (!to.length) return;
    const { notifyUsers } = await import("@/lib/notify");
    const { erpLink } = await import("../registry");
    await notifyUsers(to.map((userId) => ({ userId, title: n.title, body: n.body, kind: n.kind ?? "info", href: erpLink(n.view, { open: n.open ?? null }) })));
  } catch {
    /* A bell that could not be written never undoes a record already saved. */
  }
}
