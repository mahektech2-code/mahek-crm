import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "../business-date";
import { newestOf, type FactoryHandsetRow, type FactoryHandsetsPayload } from "../factory-handsets";

/**
 * Every factory phone, as it last described itself, and every factory worker
 * no phone has reported for.
 *
 * A row is a PHONE, not a person: a station phone is shared across a shift,
 * so it carries whoever was signed in at its last report. A worker who has
 * never been the last person on any phone still gets a row of their own,
 * "no phone yet" — the person a rollout is most likely to miss is the one a
 * table of phones would silently leave out. Who counts as a factory worker:
 * anybody with a floor profile (a PIN and a department) or the Factory app
 * granted, and an active account.
 *
 * Beside each phone, today's loading scans by its person (`factory_scan_events`):
 * how many, the last, the median wait and how many the phone judged
 * differently from the server.
 */
export async function listFactoryHandsets(): Promise<FactoryHandsetsPayload> {
  const [devices, people, scans] = await Promise.all([
    db.execute(sql`
      select d.*, g.name as godown
        from factory_devices d left join erp_godowns g on g.id = d.godown_id
       order by d.last_seen_at desc`) as unknown as Promise<Record<string, unknown>[]>,
    db.execute(sql`
      select u.id, u.name, u.phone, s.area, s.role_label as "roleLabel"
        from users u left join factory_staff s on s.user_id = u.id
       where u.active and (s.user_id is not null or exists (select 1 from app_access a where a.user_id = u.id and a.app = 'factory'))`) as unknown as Promise<
      { id: string; name: string; phone: string | null; area: string | null; roleLabel: string | null }[]
    >,
    db.execute(sql`
      select user_id as "userId", count(*)::int as n, max(received_at) as last,
             percentile_cont(0.5) within group (order by wait_ms) filter (where wait_ms is not null) as wait,
             count(*) filter (where agree = false)::int as disagree
        from factory_scan_events
       where received_at >= (date_trunc('day', now() at time zone ${APP_TIMEZONE}) at time zone ${APP_TIMEZONE})
       group by user_id`) as unknown as Promise<{ userId: string; n: number; last: string | Date | null; wait: number | string | null; disagree: number }[]>,
  ]);

  const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());
  const num = (v: unknown) => (v == null ? null : Number(v));
  const byPerson = new Map(people.map((p) => [p.id, p]));
  const scanOf = new Map(scans.map((s) => [s.userId, s]));
  const scanFields = (userId: string | null) => {
    const s = userId ? scanOf.get(userId) : undefined;
    return { scansToday: Number(s?.n ?? 0), lastScanAt: iso(s?.last), medianWaitMs: s?.wait == null ? null : Math.round(Number(s.wait)), disagreeToday: Number(s?.disagree ?? 0) };
  };

  const rows: FactoryHandsetRow[] = devices.map((d) => {
    const userId = (d.user_id as string | null) ?? null;
    const p = userId ? byPerson.get(userId) : undefined;
    return {
      deviceId: String(d.id),
      userId,
      name: p?.name ?? "Nobody signed in",
      phone: p?.phone ?? null,
      area: p?.area ?? null,
      roleLabel: p?.roleLabel ?? null,
      godown: (d.godown as string | null) ?? null,
      lastSeenAt: iso(d.last_seen_at),
      firstSeenAt: iso(d.first_seen_at),
      appVersion: (d.app_version as string | null) ?? null,
      updateId: (d.update_id as string | null) ?? null,
      updateCreatedAt: iso(d.update_created_at),
      embedded: (d.embedded as boolean | null) ?? null,
      channel: (d.channel as string | null) ?? null,
      os: (d.os as string | null) ?? null,
      osVersion: (d.os_version as string | null) ?? null,
      apiLevel: num(d.api_level),
      brand: (d.brand as string | null) ?? null,
      manufacturer: (d.manufacturer as string | null) ?? null,
      model: (d.model as string | null) ?? null,
      network: (d.network as string | null) ?? null,
      internet: (d.internet as boolean | null) ?? null,
      queuePending: num(d.queue_pending),
      queueHeld: num(d.queue_held),
      queueOldestAt: iso(d.queue_oldest_at),
      camera: (d.camera as string | null) ?? null,
      screen: (d.screen as string | null) ?? null,
      fontScalePct: num(d.font_scale_pct),
      clockSkewMs: num(d.clock_skew_ms),
      lang: (d.lang as string | null) ?? null,
      ...scanFields(userId),
    };
  });

  const onAPhone = new Set(rows.map((r) => r.userId).filter(Boolean));
  for (const p of people) {
    if (onAPhone.has(p.id)) continue;
    rows.push({
      deviceId: null, userId: p.id, name: p.name, phone: p.phone, area: p.area, roleLabel: p.roleLabel, godown: null,
      lastSeenAt: null, firstSeenAt: null, appVersion: null, updateId: null, updateCreatedAt: null, embedded: null, channel: null,
      os: null, osVersion: null, apiLevel: null, brand: null, manufacturer: null, model: null, network: null, internet: null,
      queuePending: null, queueHeld: null, queueOldestAt: null, camera: null, screen: null, fontScalePct: null, clockSkewMs: null, lang: null,
      ...scanFields(p.id),
    });
  }
  return { rows, newest: newestOf(rows) };
}
