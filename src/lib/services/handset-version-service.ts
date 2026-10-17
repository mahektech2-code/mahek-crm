import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "../config/store";
import { newestVersion, type HandsetRow, type HandsetsPayload } from "../handset-versions";

/**
 * Everybody who can sign in to MBOS, and the build their handset is running.
 *
 * Every holder of the `field` grant is listed, phone or not — a salesman with
 * no handset is the one a rollout is most likely to miss, and a table that
 * dropped him would read as everybody being upgraded. The handset is the
 * ACTIVE binding: a released phone is not one anybody is carrying.
 *
 * "Last heard" is the newest of the three moments a handset speaks — any
 * request (the heartbeat), a location upload and a sign-in — because an old
 * build that predates the heartbeat still uploads and still signs in.
 */
export async function listHandsets(): Promise<HandsetsPayload> {
  const [rows, config] = await Promise.all([
    db.execute<{
      userId: string;
      name: string;
      phone: string | null;
      email: string | null;
      deviceId: string | null;
      model: string | null;
      platform: string | null;
      appVersion: string | null;
      appVersionReportedAt: string | Date | null;
      appVersionChangedAt: string | Date | null;
      lastHeardAt: string | Date | null;
      boundAt: string | Date | null;
    }>(sql`
      select u.id as "userId", u.name, u.phone, u.email,
             d.device_id as "deviceId", d.model, d.platform,
             d.app_version as "appVersion",
             d.app_version_reported_at as "appVersionReportedAt",
             d.app_version_changed_at as "appVersionChangedAt",
             greatest(d.last_request_at, d.last_seen_at, d.bound_at) as "lastHeardAt",
             d.bound_at as "boundAt"
        from users u
        join app_access a on a.user_id = u.id and a.app = 'field'
        left join lateral (
          select * from mbos_devices x
           where x.user_id = u.id and x.active
           order by x.bound_at desc
           limit 1
        ) d on true
       where u.active
       order by u.name asc`),
    getConfig(),
  ]);

  /* db.execute hands timestamps back as strings on some paths and Dates on
     others; the browser gets one shape. */
  const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());
  const list: HandsetRow[] = (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    userId: r.userId as string,
    name: r.name as string,
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    deviceId: (r.deviceId as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    platform: (r.platform as string | null) ?? null,
    appVersion: (r.appVersion as string | null) ?? null,
    appVersionReportedAt: iso(r.appVersionReportedAt as string | Date | null),
    appVersionChangedAt: iso(r.appVersionChangedAt as string | Date | null),
    lastHeardAt: iso(r.lastHeardAt as string | Date | null),
    boundAt: iso(r.boundAt as string | Date | null),
  }));

  /* The build everybody should be on: the one somebody named in Settings, or
     failing that the newest any phone reports — said which, on the screen. */
  const named = String(config["mbos.sync.currentAppVersion"] ?? "").trim();
  const newest = newestVersion(list.map((r) => r.appVersion));
  return {
    rows: list,
    reference: named || newest,
    referenceSource: named ? "setting" : newest ? "newest" : null,
    at: new Date().toISOString(),
  };
}
