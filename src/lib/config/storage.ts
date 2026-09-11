import { sql } from "drizzle-orm";

/**
 * What actually goes into `app_settings.value`.
 *
 * THE COLUMN IS `jsonb NOT NULL`, and a setting whose value is legitimately
 * null — `mbos.attendance.baseLocation`, which is no office picked yet — hands
 * Drizzle a JS `null`, which becomes SQL NULL and violates it. JSON null and
 * SQL NULL are different things and only one of them is a value; this writes
 * the one that is.
 *
 * **It lives in its own file because there are FOUR writers and they are in
 * two projects' worth of directories.** `config/store.ts` is `server-only` and
 * `db/seed.ts` is a script, so the seed could not have imported the helper
 * where it was first written — which is exactly how the fix for this landed
 * covering five call sites and missing the sixth. The integration suite went
 * green and the link crawl stayed red on the same error, hours apart, because
 * one of them seeds through the store and the other seeds through itself.
 *
 * The `as never` every call site used is why no type checker ever objected: a
 * cast that quiets an error across a boundary is the bug and not the fix.
 */
export function storedSettingValue(value: unknown) {
  return (value === null ? sql`'null'::jsonb` : value) as never;
}
