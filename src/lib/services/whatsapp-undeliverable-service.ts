import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { resolveScope, scopedToUsers, scopedUserIds } from "../access-control";
import { asDate } from "../business-date";
import { UNDELIVERABLE_SQL_PATTERN } from "../whatsapp-undeliverable";

/* ---------------------------------------------------------------------------
 * Who WhatsApp cannot reach on the number we hold — see
 * `lib/whatsapp-undeliverable.ts` for why this is its own kind of failure.
 *
 * Derived, never stored: a customer is on this list while the NEWEST message
 * that reached a verdict on their CURRENT number (`whatsapp_phone`, else
 * `phone` — what a send is addressed to) failed as undeliverable, and they
 * have not written to us since. Change the number, get one message through,
 * or hear from them, and they are off it.
 * ------------------------------------------------------------------------- */

export type Undeliverable = {
  customerId: string;
  name: string;
  /** Last ten digits of the number that failed. */
  number: string;
  failedAt: Date;
};

const last10 = (col: SQL) => sql`right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 10)`;

async function read(scope: SQL | undefined): Promise<Undeliverable[]> {
  const rows = await db.execute<{ customer_id: string; name: string; number: string; failed_at: unknown }>(sql`
    with latest as (
      select distinct on (m.customer_id)
             m.customer_id, m.status::text as status, m.failure_reason, m.updated_at
        from wa_messages m
        join customers on customers.id = m.customer_id
       where m.dest_kind = 'personal'
         and ${last10(sql`m.resolved_destination`)} = ${last10(sql`coalesce(customers.whatsapp_phone, customers.phone)`)}
         and ${last10(sql`m.resolved_destination`)} <> ''
         and m.status::text not in ('prepared', 'copied', 'cancelled')
       order by m.customer_id, m.updated_at desc, m.id desc
    )
    select customers.id as customer_id, customers.name,
           ${last10(sql`coalesce(customers.whatsapp_phone, customers.phone)`)} as number,
           latest.updated_at as failed_at
      from latest
      join customers on customers.id = latest.customer_id
     where latest.status = 'failed'
       and coalesce(latest.failure_reason, '') ~ ${UNDELIVERABLE_SQL_PATTERN}
       and not exists (
         select 1 from wa_replies r
          where r.customer_id = latest.customer_id and r.received_at > latest.updated_at
       )
       ${scope ? sql`and ${scope}` : sql``}
     order by customers.name
  `);
  return rows.map((r) => ({
    customerId: r.customer_id,
    name: r.name,
    number: r.number,
    failedAt: asDate(r.failed_at) ?? new Date(0),
  }));
}

/** Every customer the rule must not send to, whoever is asking — for the job. */
export async function undeliverableByCustomer(): Promise<Map<string, Undeliverable>> {
  return new Map((await read(undefined)).map((u) => [u.customerId, u]));
}

/** The same list, narrowed to the caller's book — for the WhatsApp screen. */
export async function listUndeliverable(): Promise<Undeliverable[]> {
  const ctx = await resolveScope();
  return read(scopedToUsers(scopedUserIds(ctx.scope)));
}
