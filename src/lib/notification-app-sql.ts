import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { APP_ROUTES } from "./app-routes";

/**
 * `notificationAppOf` as SQL, built from the SAME prefix list — so the bell's
 * filter, its per-app counts and "mark this app's read" all agree with the
 * browser about which app a row belongs to. `notification-apps.db.test.ts`
 * runs both over the same links and fails if they ever answer differently.
 *
 * The prefixes are constants in code, never input, and none contains a quote
 * or a LIKE wildcard; the assertion below keeps it that way.
 */
export function notificationAppSql(table = "notifications"): SQL {
  const whens = APP_ROUTES.map(([prefix, app]) => {
    if (!/^\/[a-z/-]+$/.test(prefix) || !/^[a-z]+$/.test(app)) {
      throw new Error(`notificationAppSql: unexpected route ${prefix} → ${app}`);
    }
    return `when ${table}.href = '${prefix}' or ${table}.href like '${prefix}/%' or ${table}.href like '${prefix}?%' or ${table}.href like '${prefix}#%' then '${app}'`;
  }).join(" ");
  return sql.raw(
    `(case ${whens} when coalesce(${table}.href, '') = '' and coalesce(${table}.mbos_href, '') <> '' then 'field' else null end)`,
  );
}
