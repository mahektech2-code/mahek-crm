import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APPS, type AppId } from "@/lib/apps";
import { APP_TIMEZONE } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * What the console's Home reads beyond the attention list: how long the
 * database takes to answer, sign-ins over the last fortnight, and each app's
 * people and who of them signed in today. Every figure is a query.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r = (await db.execute(q)) as unknown as { rows?: Row[] } | Row[];
  return (Array.isArray(r) ? r : (r.rows ?? [])) as T[];
}

/** One round trip, timed — the database's own answer to "are you there". */
export async function databasePing(): Promise<{ ok: boolean; ms: number }> {
  const started = performance.now();
  try {
    await db.execute(sql`select 1`);
    return { ok: true, ms: Math.max(1, Math.round(performance.now() - started)) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started) };
  }
}

export type SignInDay = { day: string; n: number; sunday: boolean };

/** People who signed in, per day, for the last `days` days ending today (Asia/Kolkata). */
export async function signInsByDay(days = 14): Promise<SignInDay[]> {
  const list = await rows<{ day: string; n: number; dow: number }>(sql`
    with d as (
      select generate_series(
        (now() at time zone ${APP_TIMEZONE})::date - ${days - 1}::int,
        (now() at time zone ${APP_TIMEZONE})::date,
        interval '1 day'
      )::date as day
    )
    select to_char(d.day, 'YYYY-MM-DD') as day,
           extract(dow from d.day)::int as dow,
           (select count(distinct a.user_id)::int from attendance a where a.day = d.day) as n
      from d
     order by d.day`);
  return list.map((r) => ({ day: r.day, n: Number(r.n), sunday: Number(r.dow) === 0 }));
}

export type AppPulse = {
  id: AppId;
  name: string;
  built: boolean;
  people: number;
  signedInToday: number;
  /** Open alerts the app raises about itself — the ERP's unusual-activity checks. */
  alerts: number;
};

/** Every live app: who holds it, who of them signed in today, and its open alerts. */
export async function appPulse(): Promise<AppPulse[]> {
  const [held, alerts] = await Promise.all([
    rows<{ app: string; people: number; today: number }>(sql`
      select g.app::text as app,
             count(distinct g.user_id)::int as people,
             count(distinct g.user_id) filter (
               where exists (
                 select 1 from attendance a
                  where a.user_id = g.user_id
                    and a.day = (now() at time zone ${APP_TIMEZONE})::date
               )
             )::int as today
        from app_access g
        join users u on u.id = g.user_id and u.active
       group by g.app`),
    rows<{ n: number }>(sql`select count(*)::int as n from erp_alerts where resolved_at is null`).catch(() => [{ n: 0 }]),
  ]);
  const by = new Map(held.map((h) => [h.app, h]));
  return APPS.filter((a) => !a.retiredInto).map((a) => ({
    id: a.id,
    name: a.name,
    built: a.built,
    people: Number(by.get(a.id)?.people ?? 0),
    signedInToday: Number(by.get(a.id)?.today ?? 0),
    alerts: a.id === "erp" ? Number(alerts[0]?.n ?? 0) : 0,
  }));
}

/** The newest sheet sync that finished, and how it ended — null where none ever ran. */
export async function lastSheetSync(): Promise<{ at: Date; ok: boolean } | null> {
  const list = await rows<{ at: string | Date; status: string }>(sql`
    select finished_at as at, status from sheet_sync_runs
     where finished_at is not null
     order by started_at desc limit 1`);
  const r = list[0];
  return r ? { at: new Date(r.at), ok: r.status === "succeeded" || r.status === "success" || r.status === "ok" } : null;
}
