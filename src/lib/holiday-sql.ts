import { sql, type SQL } from "drizzle-orm";

/**
 * IS THIS HOLIDAY HIS DAY OFF — the one SQL statement of it, for every reader
 * that asks per person: the attendance verdict, leave, the journey calendar
 * and the handset's `universal`.
 *
 * A company-wide holiday reaches everybody nobody has taken it away from; any
 * other level reaches exactly the people `mbos_holiday_members` lists, which
 * `rebuildHolidayMembers` resolves from places, territories and the per-person
 * allocations (`lib/engines/holiday-audience.ts`). Company rows are not
 * listed there, so a salesman granted the field app this minute already has
 * every company holiday before any rebuild has run.
 *
 * `h` is the alias the caller gave `mbos_holidays`; `user` is an expression
 * naming the person — a column such as `d.user_id`, or a bound id.
 */
export function holidayAppliesSql(h: string, user: SQL): SQL {
  const alias = sql.raw(h);
  return sql`(
    (${alias}.level = 'company'
      and not exists (select 1 from mbos_holiday_assignments ha
                       where ha.holiday_id = ${alias}.id and ha.user_id = ${user} and ha.mode = 'exclude'))
    or exists (select 1 from mbos_holiday_members hm
                where hm.holiday_id = ${alias}.id and hm.user_id = ${user})
  )`;
}

/** A holiday nobody in particular is asked about — the company calendar. */
export function companyHolidaySql(h: string): SQL {
  return sql`${sql.raw(h)}.level = 'company'`;
}
