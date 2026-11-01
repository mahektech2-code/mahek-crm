import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { FactoryCtx } from "./server";
import type { FactoryDeviceReport } from "./types";

/* ---------------------------------------------------------------------------
 * A FACTORY PHONE DESCRIBES ITSELF, and this keeps the latest description.
 *
 * Every field is the phone's own reading and arrives as text from a device
 * somebody owns, so each is trimmed to a sane length and type here and a
 * nonsense value becomes unknown rather than a refusal: a report is a
 * courtesy, and nothing about the floor's work may ever fail because one was
 * odd. A field the phone did not send is written as unknown too — the row is
 * what the phone said LAST, not a merge of everything it ever said, so a
 * camera permission taken away reads as taken away.
 *
 * Only a signed-in phone reports (the action asks for the session), so the
 * person and the godown are the session's, never the payload's.
 * ------------------------------------------------------------------------- */

const text = (v: unknown, max = 80): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const instant = (v: unknown): string | null => {
  const s = text(v, 40);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};

/** Twelve hours either way is a clock set to the wrong day, not a phone that is slightly off; past that it is not believed. */
const SKEW_MAX_MS = 12 * 3600_000;

export async function recordDevice(fc: FactoryCtx, r: FactoryDeviceReport, nowMs = Date.now()): Promise<{ ok: boolean }> {
  const id = text(r?.deviceId, 64);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return { ok: false };
  const sent = instant(r.sentAt);
  const skew = sent ? Date.parse(sent) - nowMs : null;
  const fontScale = Number(r.fontScale);
  const v = {
    appVersion: text(r.appVersion, 20),
    appBuild: text(r.appBuild, 40),
    updateId: text(r.updateId, 64),
    updateCreatedAt: instant(r.updateCreatedAt),
    runtime: text(r.runtime, 20),
    channel: text(r.channel, 40),
    embedded: bool(r.embedded),
    os: text(r.os, 20),
    osVersion: text(r.osVersion, 20),
    apiLevel: int(r.apiLevel, 1, 200),
    brand: text(r.brand, 40),
    manufacturer: text(r.manufacturer, 40),
    model: text(r.model, 60),
    network: text(r.network, 20),
    internet: bool(r.internet),
    queuePending: int(r.queuePending, 0, 100_000),
    queueHeld: int(r.queueHeld, 0, 100_000),
    queueOldestAt: instant(r.queueOldestAt),
    camera: text(r.camera, 20),
    screen: text(r.screen, 20),
    fontScalePct: Number.isFinite(fontScale) && fontScale > 0.3 && fontScale < 5 ? Math.round(fontScale * 100) : null,
    clockSkewMs: skew != null && Math.abs(skew) <= SKEW_MAX_MS ? Math.round(skew) : null,
    lang: text(r.lang, 8),
  };
  await db.execute(sql`
    insert into factory_devices (id, user_id, godown_id, app_version, app_build, update_id, update_created_at, runtime, channel, embedded,
                                 os, os_version, api_level, brand, manufacturer, model, network, internet,
                                 queue_pending, queue_held, queue_oldest_at, camera, screen, font_scale_pct, clock_skew_ms, lang)
    values (${id}, ${fc.user.id}, ${fc.godown.id}, ${v.appVersion}, ${v.appBuild}, ${v.updateId}, ${v.updateCreatedAt}::timestamptz, ${v.runtime}, ${v.channel}, ${v.embedded},
            ${v.os}, ${v.osVersion}, ${v.apiLevel}, ${v.brand}, ${v.manufacturer}, ${v.model}, ${v.network}, ${v.internet},
            ${v.queuePending}, ${v.queueHeld}, ${v.queueOldestAt}::timestamptz, ${v.camera}, ${v.screen}, ${v.fontScalePct}, ${v.clockSkewMs}, ${v.lang})
    on conflict (id) do update set
      user_id = excluded.user_id, godown_id = excluded.godown_id, last_seen_at = now(),
      app_version = excluded.app_version, app_build = excluded.app_build, update_id = excluded.update_id, update_created_at = excluded.update_created_at,
      runtime = excluded.runtime, channel = excluded.channel, embedded = excluded.embedded,
      os = excluded.os, os_version = excluded.os_version, api_level = excluded.api_level,
      brand = excluded.brand, manufacturer = excluded.manufacturer, model = excluded.model,
      network = excluded.network, internet = excluded.internet,
      queue_pending = excluded.queue_pending, queue_held = excluded.queue_held, queue_oldest_at = excluded.queue_oldest_at,
      camera = excluded.camera, screen = excluded.screen, font_scale_pct = excluded.font_scale_pct,
      clock_skew_ms = excluded.clock_skew_ms, lang = excluded.lang`);
  return { ok: true };
}
