import "server-only";
import { ADMIN } from "@/lib/admin-routes";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { mailConfigured } from "@/lib/mailer";
import { notificationAppName, notificationAppOf } from "@/lib/notification-apps";
import { whatsappServiceState } from "@/lib/services/whatsapp-switch-service";
import { secretStatuses } from "@/lib/secrets";

/**
 * What the Notifications screen reads, in one place: the bell, the pushes
 * that rode on it, WhatsApp, the templates, the channels and the
 * announcements. Every figure is counted here off its own table — there is no
 * delivery log for pushes beyond the receipt worklist, so a push figure is
 * what that table can honestly say (failed), never a delivered percentage.
 */

type Row = Record<string, unknown>;
const rows = async <T extends Row>(q: ReturnType<typeof sql>) => (await db.execute<T>(q)) as unknown as T[];
const n = (v: unknown) => Number(v ?? 0);

/** Midnight today in India, as an instant. */
const TODAY = sql`(date_trunc('day', now() at time zone ${APP_TIMEZONE}) at time zone ${APP_TIMEZONE})`;

export type NotificationFigures = {
  bellToday: number;
  unreadOld: number;
  pushFailed7d: number;
  pushWaiting: number;
  waSent30d: number;
  waFailed30d: number;
};

export async function notificationFigures(): Promise<NotificationFigures> {
  const [bell] = await rows<{ today: number; old: number }>(sql`
    select count(*) filter (where created_at >= ${TODAY})::int as today,
           count(*) filter (where not read and created_at < now() - interval '2 days')::int as old
    from notifications`);
  const [push] = await rows<{ failed: number; waiting: number }>(sql`
    select count(*) filter (where status = 'failed' and sent_at >= now() - interval '7 days')::int as failed,
           count(*) filter (where status = 'accepted')::int as waiting
    from mbos_push_receipts`);
  const [wa] = await rows<{ sent: number; failed: number }>(sql`
    select count(*) filter (where status in ('sent_manually','sent','delivered','read'))::int as sent,
           count(*) filter (where status = 'failed')::int as failed
    from wa_messages where prepared_at >= now() - interval '30 days'`);
  return {
    bellToday: n(bell?.today),
    unreadOld: n(bell?.old),
    pushFailed7d: n(push?.failed),
    pushWaiting: n(push?.waiting),
    waSent30d: n(wa?.sent),
    waFailed30d: n(wa?.failed),
  };
}

export type TemplateRow = {
  id: string;
  name: string;
  category: string;
  watiName: string | null;
  active: boolean;
  sent30d: number;
  body: string;
};

export async function templateRows(): Promise<TemplateRow[]> {
  const r = await rows<{ id: string; name: string; body: string; category: string; wati: string | null; active: boolean; sent: number }>(sql`
    select t.id, t.name, t.body, t.category::text as category, t.wati_template_name as wati, t.active,
           (select count(*)::int from wa_messages m
             where m.template_id = t.id and m.prepared_at >= now() - interval '30 days'
               and m.status in ('sent_manually','sent','delivered','read')) as sent
    from wa_templates t
    order by t.active desc, sent desc, t.name`);
  return r.map((t) => ({ id: t.id, name: t.name, category: t.category, watiName: t.wati, active: t.active, sent30d: n(t.sent), body: t.body }));
}

/** Today's bell rows by the app their link opens — the same rule every bell files them by. */
export async function bellByApp(): Promise<{ app: string; n: number }[]> {
  const r = await rows<{ href: string | null; mbos: string | null; n: number }>(sql`
    select href, mbos_href as mbos, count(*)::int as n
    from notifications where created_at >= ${TODAY}
    group by href, mbos_href`);
  const by = new Map<string, number>();
  for (const x of r) {
    const app = notificationAppOf(x.href, x.mbos);
    const label = app ? notificationAppName(app) : "General";
    by.set(label, (by.get(label) ?? 0) + n(x.n));
  }
  return [...by.entries()].map(([app, c]) => ({ app, n: c })).sort((a, b) => b.n - a.n);
}

export type Channel = { name: string; on: boolean; line: string; setHref?: string };

export async function channels(): Promise<Channel[]> {
  const [wa, secrets, [push]] = await Promise.all([
    whatsappServiceState(),
    secretStatuses(),
    rows<{ devices: number }>(sql`select count(*)::int as devices from mbos_devices where push_token is not null`),
  ]);
  const wati = secrets.find((x) => x.name === "wati.apiToken")?.source !== "unset";
  const devices = n(push?.devices);
  return [
    { name: "Bell", on: true, line: "In every app's header — always on" },
    {
      name: "Push · handsets",
      on: devices > 0,
      line: devices ? `${devices} handset${devices === 1 ? "" : "s"} can be reached` : "No handset has registered for pushes",
    },
    {
      name: "Email",
      on: mailConfigured(),
      line: mailConfigured() ? "Sent through Resend" : "No mail provider — mail is written to the server log",
    },
    {
      name: "WhatsApp",
      on: wa.active && wati,
      line: !wati ? "No Wati key" : wa.active ? "Switched on in HQ" : "Switched off in HQ",
      setHref: wati ? undefined : ADMIN.integrations,
    },
  ];
}

export type AnnouncementRow = { id: string; title: string; text: string; from: string; to: string; source: string; reached: number; read: number; at: Date };

export async function announcementRows(limit = 50): Promise<AnnouncementRow[]> {
  const r = await rows<{ id: string; title: string | null; text: string; from_name: string; to_label: string; source: string; reached: number; read: number; at: Date }>(sql`
    select a.id, a.title, a.text, a.from_name, a.to_label, a.source,
           jsonb_array_length(a.bell_ids)::int as reached,
           (select count(*)::int from notifications b
             where b.read and b.id in (select jsonb_array_elements_text(a.bell_ids))) as read,
           a.created_at as at
    from hrms_notifications a
    where a.deleted_at is null
    order by a.created_at desc limit ${limit}`);
  return r.map((a) => ({
    id: a.id,
    title: a.title ?? a.from_name,
    text: a.text,
    from: a.from_name,
    to: a.to_label,
    source: a.source,
    reached: n(a.reached),
    read: n(a.read),
    at: new Date(a.at),
  }));
}
