import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { supersededStatusOn } from "@/lib/engines/price-supersede";

/* ---------------------------------------------------------------------------
 * ONE LIST TAKING OVER FROM ANOTHER — said once, for every door that publishes.
 *
 * A version dated for a later day must not cut the old one off today. Only a
 * published list prices, so marking the old list `superseded` at the moment
 * the new one was PUBLISHED left every shop on it falling to a wider list —
 * the Standard list — until the new one's date arrived. So the old list is
 * dated out (`effective_to` = the day before the new one starts) and stays
 * `published` until that day has passed; then `supersedeEndedPriceLists`, run
 * hourly and nightly, files it as `superseded`. The resolver already reads
 * `effective_to`, so a list that has ended prices nothing even before the job
 * has run.
 *
 * The link is the NEW list's `supersedes_id`; nothing is stored on the old.
 *
 * Plain module, not "use server": both helpers are called from inside actions
 * that have already checked who is asking, and an export from an action file
 * is a URL anybody can post to.
 * ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Date `oldId` out to the day before `newFrom`, inside the publishing
 * transaction. Superseded at once where that day is already past; otherwise
 * left published until the hourly step catches it.
 */
export async function supersedePredecessor(
  tx: Tx,
  input: { oldId: string; newFrom: string; day: string; userId: string },
): Promise<{ effectiveTo: string; status: "published" | "superseded" }> {
  const effectiveTo = addDays(input.newFrom, -1);
  const status = supersededStatusOn(effectiveTo, input.day);
  await tx.execute(sql`
    update price_lists
       set status = ${status}, effective_to = ${effectiveTo},
           updated_at = now(), updated_by_id = ${input.userId}
     where id = ${input.oldId} and status = 'published'
  `);
  return { effectiveTo, status };
}

/**
 * The published list that has already been replaced by `oldId`'s successor, if
 * any — a published (or since-superseded) list naming it as `supersedes_id`.
 * A list has ONE successor: a second would leave two versions both claiming
 * to take over on different days.
 */
export async function publishedSuccessor(
  tx: Tx | typeof db,
  oldId: string,
  exceptId?: string,
): Promise<{ id: string; name: string; effectiveFrom: string } | null> {
  const [row] = await tx.execute<{ id: string; name: string; effectiveFrom: string }>(sql`
    select l.id, l.name, l.effective_from::text as "effectiveFrom"
      from price_lists l
     where l.supersedes_id = ${oldId}
       and l.status in ('published', 'superseded')
       and (${exceptId ?? null}::text is null or l.id <> ${exceptId ?? null})
     order by l.effective_from desc
     limit 1
  `);
  return row ?? null;
}

/**
 * Every published list whose successor has taken over, filed as superseded.
 * Idempotent: a list already superseded is not touched, and a list dated out
 * with nobody taking over (there is no such writer, but a hand edit could make
 * one) is left alone, because "superseded" names a successor.
 */
export async function supersedeEndedPriceLists(day?: string): Promise<number> {
  const on = day ?? (await today());
  const rows = (await db.execute(sql`
    update price_lists o
       set status = 'superseded', updated_at = now()
     where o.status = 'published'
       and o.effective_to is not null
       and o.effective_to < ${on}::date
       and exists (
         select 1 from price_lists n
          where n.supersedes_id = o.id and n.status in ('published', 'superseded')
       )
    returning o.id
  `)) as unknown as unknown[];
  return rows.length;
}
