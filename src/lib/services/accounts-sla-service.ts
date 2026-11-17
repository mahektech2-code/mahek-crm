import "server-only";
import { awaitingAccountsSql } from "@/lib/order-status";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { notifyUsers, type NotifyEntry } from "@/lib/notify";
import { money } from "@/lib/format";
import {
  escalationLevel,
  hoursLabel,
  judge,
  SLA_KIND_LABEL,
  SLA_KINDS,
  type SlaCalendar,
  type SlaCandidate,
  type SlaClock,
  type SlaKind,
} from "@/lib/engines/accounts-sla";

/* ---------------------------------------------------------------------------
 * THE ACCOUNTS DEADLINE, wired to data.
 *
 * Four queues wait on the ledger desk — orders to approve, payments to
 * confirm, credit notes and order changes to decide. Whatever has waited past
 * `accountsSla.hours` WORKING hours (`lib/engines/accounts-sla.ts` is the
 * clock) becomes one `accounts_sla_breaches` row, and three things follow:
 *
 * 1. The ADMINS are told, once, at the deadline — every platform administrator
 *    and every administrator of the Founder app — and again every further
 *    `accountsSla.escalateEveryHours` working hours, with the latest reason.
 * 2. The ACCOUNTS TEAM is told on their bell, and every screen of the Accounts
 *    app asks them, in a dialog they cannot close without answering, WHY it is
 *    not done and WHEN to ask again. The reason is shared: once anybody on
 *    the desk has answered, the desk is covered until the reminder falls due.
 * 3. The FOUNDER sees it on Command Centre → Accounts deadlines.
 *
 * The admins being told does not move the work to them. Nothing here
 * reassigns anything: the item stays on the accounts desk, the dialog keeps
 * coming back, and the admins keep being told, until accounts DECIDE it. That
 * is the accountability the feature exists for.
 *
 * A row is resolved by the same sweep the moment its record leaves its queue,
 * whoever decided it and from wherever.
 * ------------------------------------------------------------------------- */

export const SLA_MODULE: Record<SlaKind, string> = {
  order: "accounts.approvals",
  payment: "accounts.payments",
  credit_note: "accounts.credits",
  order_change: "accounts.order-changes",
};

export const SLA_HREF: Record<SlaKind, string> = {
  order: "/accounts/approvals",
  payment: "/accounts/payments",
  credit_note: "/accounts/credits",
  order_change: "/accounts/order-changes",
};

export const FOUNDER_DEADLINES_HREF = "/founder/accounts-deadlines";

type Pending = SlaCandidate & {
  customerName: string | null;
  amountPaise: number | null;
  reference: string | null;
};

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ------------------------------------------------------------ the calendar */

export async function slaSettings() {
  const config = await getConfig();
  const clock: SlaClock = config["accountsSla.clock"] === "office_hours" ? "office_hours" : "working_days";
  const rows = await db.execute<{ d: string }>(sql`
    select on_date::text as d from mbos_holidays
     where level = 'company'
       and on_date between (now() - interval '400 days')::date and (now() + interval '60 days')::date
  `);
  const calendar: SlaCalendar = {
    clock,
    workingDays: config["workingDay.workingDays"],
    shiftStart: config["workingDay.shiftStart"],
    shiftEnd: config["workingDay.shiftEnd"],
    holidays: new Set(rows.map((r) => String(r.d))),
  };
  return {
    enabled: config["accountsSla.enabled"],
    hours: config["accountsSla.hours"],
    escalateEvery: config["accountsSla.escalateEveryHours"],
    includeHeld: config["accountsSla.includeHeldPayments"],
    calendar,
  };
}

/* ---------------------------------------------------------- what is waiting */

async function pendingItems(includeHeld: boolean): Promise<Pending[]> {
  const receiptStatuses = includeHeld ? sql`('reported','held')` : sql`('reported')`;
  const rows = await db.execute<{
    kind: SlaKind;
    record_id: string;
    since_ms: number;
    customer_name: string | null;
    amount: string | null;
    reference: string | null;
  }>(sql`
    select 'order' as kind, o.id as record_id,
           (extract(epoch from o.created_at) * 1000)::float8 as since_ms,
           c.name as customer_name, o.total_amount::text as amount, o.order_no as reference
      from orders o join customers c on c.id = o.customer_id
     where ${awaitingAccountsSql("o")}
    union all
    select 'payment', r.id, (extract(epoch from r.created_at) * 1000)::float8,
           c.name, r.amount::text, null
      from payment_receipts r join customers c on c.id = r.customer_id
     where r.status in ${receiptStatuses}
    union all
    select 'credit_note', k.id, (extract(epoch from k.created_at) * 1000)::float8,
           c.name, k.cn_amount::text, null
      from complaints k join customers c on c.id = k.customer_id
     where k.request_cn = true and coalesce(k.cn_status::text, 'requested') in ('requested','under_review')
    union all
    select 'order_change', q.id, (extract(epoch from q.created_at) * 1000)::float8,
           c.name, q.total_amount_paise::text, o.order_no
      from order_change_requests q
      join customers c on c.id = q.customer_id
      join orders o on o.id = q.order_id
     where q.status = 'pending'
  `);
  return rows.map((r) => ({
    kind: r.kind,
    recordId: r.record_id,
    sinceMs: Number(r.since_ms),
    customerName: r.customer_name,
    amountPaise: r.amount === null ? null : Number(r.amount),
    reference: r.reference,
  }));
}

function describe(p: { kind: SlaKind; customerName: string | null; amountPaise: number | null; reference: string | null }): string {
  const parts = [SLA_KIND_LABEL[p.kind]];
  if (p.reference) parts.push(p.reference);
  if (p.customerName) parts.push(p.customerName);
  if (p.amountPaise) parts.push(money(p.amountPaise));
  return parts.join(" · ");
}

/* --------------------------------------------------------------- recipients */

async function adminIds(): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select distinct u.id from users u join app_access a on a.user_id = u.id
     where u.active and a.role = 'admin' and a.app::text in ('admin','founder')
  `);
  return rows.map((r) => r.id);
}

/** Everybody on the accounts desk who can open the screen this kind is decided on. */
async function accountsIdsFor(kind: SlaKind): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select distinct u.id from users u join app_access a on a.user_id = u.id and a.app = 'accounts'
     where u.active
       and (a.role = 'admin'
            or not exists (select 1 from app_module_access m where m.user_id = u.id and m.app = 'accounts')
            or exists (select 1 from app_module_access m where m.user_id = u.id and m.app = 'accounts'
                         and m.module = ${SLA_MODULE[kind]}))
  `);
  return rows.map((r) => r.id);
}

/* -------------------------------------------------------------- the sweep */

let lastQuickSweep = 0;

/**
 * Finds what is overdue, records it, resolves what was decided, and tells
 * people. Idempotent: a breach is written once (a unique key), each notice is
 * claimed by a conditional update before it is sent, so two sweeps at once
 * tell nobody twice.
 *
 * `quick` is for page loads: it returns at once if a sweep ran in this process
 * in the last minute, so the Accounts app's every navigation costs nothing.
 */
export async function sweepAccountsSla(opts: { quick?: boolean; nowMs?: number } = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  if (opts.quick && nowMs - lastQuickSweep < 60_000) return { opened: 0, resolved: 0, notified: 0, escalated: 0 };
  lastQuickSweep = nowMs;

  const s = await slaSettings();
  const pending = await pendingItems(s.includeHeld);
  const byKey = new Map(pending.map((p) => [`${p.kind}:${p.recordId}`, p]));

  // Decided since: whatever left its queue is resolved, whoever decided it.
  const open = await db.execute<{ id: string; kind: SlaKind; record_id: string }>(
    sql`select id, kind, record_id from accounts_sla_breaches where resolved_at is null`,
  );
  const gone = open.filter((b) => !byKey.has(`${b.kind}:${b.record_id}`)).map((b) => b.id);
  if (gone.length) {
    await db.execute(sql`update accounts_sla_breaches set resolved_at = now()
                          where resolved_at is null and id in ${gone}`);
  }

  if (!s.enabled) return { opened: 0, resolved: gone.length, notified: 0, escalated: 0 };

  // Newly overdue.
  let opened = 0;
  for (const p of pending) {
    const v = judge(p, nowMs, s.hours, s.calendar);
    if (!v.overdue || v.dueMs === null) continue;
    const res = await db.execute<{ id: string }>(sql`
      insert into accounts_sla_breaches (id, kind, record_id, waiting_since, due_at)
      values (${newId("asla")}, ${p.kind}, ${p.recordId}, to_timestamp(${p.sinceMs / 1000}), to_timestamp(${v.dueMs / 1000}))
      on conflict (kind, record_id) do update set resolved_at = null
        where accounts_sla_breaches.resolved_at is not null
      returning id
    `);
    opened += res.length;
  }

  // The first notice: claimed, then sent.
  const fresh = await db.execute<{ id: string; kind: SlaKind; record_id: string }>(sql`
    update accounts_sla_breaches set admins_notified_at = now()
     where resolved_at is null and admins_notified_at is null
    returning id, kind, record_id
  `);
  const entries: NotifyEntry[] = [];
  const admins = fresh.length ? await adminIds() : [];
  const deskByKind = new Map<SlaKind, string[]>();
  for (const b of fresh) {
    const p = byKey.get(`${b.kind}:${b.record_id}`);
    if (!p) continue;
    const what = describe(p);
    const waited = hoursLabel(judge(p, nowMs, s.hours, s.calendar).waitedHours);
    for (const id of admins) {
      entries.push({
        userId: id,
        kind: "warn",
        title: `Accounts missed the ${s.hours}-hour deadline`,
        body: `${what} has waited ${waited} of working time without a decision.`,
        href: FOUNDER_DEADLINES_HREF,
      });
    }
    if (!deskByKind.has(b.kind)) deskByKind.set(b.kind, await accountsIdsFor(b.kind));
    for (const id of deskByKind.get(b.kind)!) {
      if (admins.includes(id)) continue;
      entries.push({
        userId: id,
        kind: "warn",
        title: `Past the ${s.hours}-hour deadline — the admins have been told`,
        body: `${what}. Decide it, or say why it is not done yet.`,
        href: SLA_HREF[b.kind],
      });
    }
  }

  // Further notices: one per further block of working hours past the deadline.
  let escalated = 0;
  if (s.escalateEvery > 0) {
    const stillOpen = await db.execute<{ id: string; kind: SlaKind; record_id: string; due_ms: number; escalations: number; remark: string | null; author: string | null }>(sql`
      select b.id, b.kind, b.record_id, (extract(epoch from b.due_at) * 1000)::float8 as due_ms, b.escalations,
             r.body as remark, u.name as author
        from accounts_sla_breaches b
        left join lateral (select body, author_id from accounts_sla_remarks
                            where breach_id = b.id and side = 'accounts' order by created_at desc limit 1) r on true
        left join users u on u.id = r.author_id
       where b.resolved_at is null and b.admins_notified_at is not null
    `);
    let admins2: string[] | null = null;
    for (const b of stillOpen) {
      const level = escalationLevel(Number(b.due_ms), nowMs, s.escalateEvery, s.calendar);
      if (level <= Number(b.escalations)) continue;
      const claimed = await db.execute(sql`
        update accounts_sla_breaches set escalations = ${level}, last_escalated_at = now()
         where id = ${b.id} and escalations < ${level} returning id
      `);
      if (!claimed.length) continue;
      escalated++;
      const p = byKey.get(`${b.kind}:${b.record_id}`);
      if (!p) continue;
      admins2 ??= await adminIds();
      const waited = hoursLabel(judge(p, nowMs, s.hours, s.calendar).waitedHours);
      const why = b.remark ? `Accounts' reason (${b.author ?? "accounts"}): “${b.remark}”` : "Accounts have given no reason yet.";
      for (const id of admins2) {
        entries.push({
          userId: id,
          kind: "danger",
          title: `Still not decided — ${waited} of working time`,
          body: `${describe(p)}. ${why}`,
          href: FOUNDER_DEADLINES_HREF,
        });
      }
    }
  }

  if (entries.length) await notifyUsers(entries);
  return { opened, resolved: gone.length, notified: fresh.length, escalated };
}

/* ------------------------------------------------- the accounts team's view */

export type DeadlineItem = {
  breachId: string;
  kind: SlaKind;
  kindLabel: string;
  description: string;
  href: string;
  waitedLabel: string;
  dueAt: string;
  /** The desk's latest reason, if any. */
  lastRemark: { body: string; by: string; at: string; remindAt: string | null } | null;
  /** The latest admin nudge, if any. */
  adminNote: { body: string; by: string; at: string } | null;
  /** ISO; the dialog asks again once this has passed. Null = never answered. */
  remindAt: string | null;
};

type BreachRow = {
  id: string;
  kind: SlaKind;
  record_id: string;
  due_at: string;
  last_body: string | null;
  last_by: string | null;
  last_at: string | null;
  remind_at: string | null;
  admin_body: string | null;
  admin_by: string | null;
  admin_at: string | null;
};

async function openBreachRows(kinds: readonly SlaKind[]): Promise<BreachRow[]> {
  if (!kinds.length) return [];
  return db.execute<BreachRow>(sql`
    select b.id, b.kind, b.record_id, b.due_at::text as due_at,
           r.body as last_body, ru.name as last_by, r.created_at::text as last_at, r.remind_at::text as remind_at,
           a.body as admin_body, au.name as admin_by, a.created_at::text as admin_at
      from accounts_sla_breaches b
      left join lateral (select * from accounts_sla_remarks where breach_id = b.id and side = 'accounts'
                          order by created_at desc limit 1) r on true
      left join users ru on ru.id = r.author_id
      left join lateral (select * from accounts_sla_remarks where breach_id = b.id and side = 'admin'
                          order by created_at desc limit 1) a on true
      left join users au on au.id = a.author_id
     where b.resolved_at is null and b.kind in ${[...kinds]}
     order by b.due_at asc
  `);
}

const iso = (t: string | null) => (t ? new Date(t).toISOString() : null);

/** What the accounts desk owes reasons for — only the kinds whose screens this person holds. */
export async function deadlineItemsFor(moduleKeys: readonly string[], nowMs = Date.now()): Promise<DeadlineItem[]> {
  const kinds = SLA_KINDS.filter((k) => moduleKeys.includes(SLA_MODULE[k]));
  const [rows, s] = await Promise.all([openBreachRows(kinds), slaSettings()]);
  if (!rows.length) return [];
  const pending = new Map((await pendingItems(true)).map((p) => [`${p.kind}:${p.recordId}`, p]));
  const out: DeadlineItem[] = [];
  for (const r of rows) {
    const p = pending.get(`${r.kind}:${r.record_id}`);
    if (!p) continue; // decided a moment ago; the next sweep resolves it
    out.push({
      breachId: r.id,
      kind: r.kind,
      kindLabel: SLA_KIND_LABEL[r.kind],
      description: describe(p),
      href: SLA_HREF[r.kind],
      waitedLabel: hoursLabel(judge(p, nowMs, s.hours, s.calendar).waitedHours),
      dueAt: iso(r.due_at)!,
      lastRemark: r.last_body ? { body: r.last_body, by: r.last_by ?? "—", at: iso(r.last_at)!, remindAt: iso(r.remind_at) } : null,
      adminNote: r.admin_body ? { body: r.admin_body, by: r.admin_by ?? "—", at: iso(r.admin_at)! } : null,
      remindAt: iso(r.remind_at),
    });
  }
  return out;
}

/* -------------------------------------------------------- the founder's view */

export type DeadlineBreach = DeadlineItem & {
  waitingSince: string;
  escalations: number;
  acknowledged: { by: string; at: string } | null;
  remarks: { side: "accounts" | "admin"; body: string; by: string; at: string; remindAt: string | null }[];
  /** True when the desk has never answered, or its reminder has passed unanswered. */
  owesReason: boolean;
};

export type ResolvedBreach = {
  id: string;
  kindLabel: string;
  description: string;
  waitingSince: string;
  dueAt: string;
  resolvedAt: string;
  lateLabel: string;
  remarks: number;
};

export type DeadlinesOverview = {
  hours: number;
  clock: SlaClock;
  enabled: boolean;
  open: DeadlineBreach[];
  resolved: ResolvedBreach[];
  /** Per kind: open now, resolved in the window. */
  byKind: { kind: SlaKind; label: string; open: number; resolved: number }[];
  windowDays: number;
};

export async function deadlinesOverview(windowDays = 30, nowMs = Date.now()): Promise<DeadlinesOverview> {
  await sweepAccountsSla({ quick: true, nowMs });
  const s = await slaSettings();
  const items = await deadlineItemsFor(Object.values(SLA_MODULE), nowMs);
  const ids = items.map((i) => i.breachId);

  const extra = ids.length
    ? await db.execute<{ id: string; since: string; escalations: number; ack_by: string | null; ack_at: string | null }>(sql`
        select b.id, b.waiting_since::text as since, b.escalations, u.name as ack_by, b.acknowledged_at::text as ack_at
          from accounts_sla_breaches b left join users u on u.id = b.acknowledged_by_id
         where b.id in ${ids}
      `)
    : [];
  const remarks = ids.length
    ? await db.execute<{ breach_id: string; side: "accounts" | "admin"; body: string; by: string; at: string; remind_at: string | null }>(sql`
        select r.breach_id, r.side, r.body, u.name as by, r.created_at::text as at, r.remind_at::text as remind_at
          from accounts_sla_remarks r join users u on u.id = r.author_id
         where r.breach_id in ${ids}
         order by r.created_at desc
      `)
    : [];
  const ex = new Map(extra.map((e) => [e.id, e]));
  const open: DeadlineBreach[] = items.map((i) => {
    const e = ex.get(i.breachId);
    return {
      ...i,
      waitingSince: iso(e?.since ?? null) ?? i.dueAt,
      escalations: Number(e?.escalations ?? 0),
      acknowledged: e?.ack_by && e.ack_at ? { by: e.ack_by, at: iso(e.ack_at)! } : null,
      remarks: remarks
        .filter((r) => r.breach_id === i.breachId)
        .map((r) => ({ side: r.side, body: r.body, by: r.by, at: iso(r.at)!, remindAt: iso(r.remind_at) })),
      owesReason: !i.remindAt || Date.parse(i.remindAt) <= nowMs,
    };
  });

  const resolvedRows = await db.execute<{ id: string; kind: SlaKind; record_id: string; since: string; due: string; resolved: string; remarks: number }>(sql`
    select b.id, b.kind, b.record_id, b.waiting_since::text as since, b.due_at::text as due, b.resolved_at::text as resolved,
           (select count(*)::int from accounts_sla_remarks r where r.breach_id = b.id and r.side = 'accounts') as remarks
      from accounts_sla_breaches b
     where b.resolved_at > now() - make_interval(days => ${windowDays})
     order by b.resolved_at desc limit 200
  `);
  const names = await recordNames(resolvedRows.map((r) => ({ kind: r.kind, id: r.record_id })));
  const resolved: ResolvedBreach[] = resolvedRows.map((r) => {
    const n = names.get(`${r.kind}:${r.record_id}`);
    const late = Math.max(0, (Date.parse(r.resolved) - Date.parse(r.due)) / 3_600_000);
    return {
      id: r.id,
      kindLabel: SLA_KIND_LABEL[r.kind],
      description: n ? describe({ kind: r.kind, ...n }) : SLA_KIND_LABEL[r.kind],
      waitingSince: iso(r.since)!,
      dueAt: iso(r.due)!,
      resolvedAt: iso(r.resolved)!,
      lateLabel: `${hoursLabel(late)} late`,
      remarks: Number(r.remarks),
    };
  });


  return {
    hours: s.hours,
    clock: s.calendar.clock,
    enabled: s.enabled,
    open,
    resolved,
    byKind: SLA_KINDS.map((k) => ({
      kind: k,
      label: SLA_KIND_LABEL[k],
      open: open.filter((o) => o.kind === k).length,
      resolved: resolvedRows.filter((r) => r.kind === k).length,
    })),
    windowDays,
  };
}

/** Customer name, amount and number for records that may have left their queue. */
async function recordNames(refs: { kind: SlaKind; id: string }[]) {
  const out = new Map<string, { customerName: string | null; amountPaise: number | null; reference: string | null }>();
  const ids = (k: SlaKind) => refs.filter((r) => r.kind === k).map((r) => r.id);
  const put = (kind: SlaKind, rows: { id: string; name: string | null; amount: string | null; ref: string | null }[]) =>
    rows.forEach((r) => out.set(`${kind}:${r.id}`, { customerName: r.name, amountPaise: r.amount ? Number(r.amount) : null, reference: r.ref }));
  const q = async (kind: SlaKind, query: (l: string[]) => ReturnType<typeof sql>) => {
    const xs = ids(kind);
    if (xs.length) put(kind, await db.execute<{ id: string; name: string | null; amount: string | null; ref: string | null }>(query(xs)));
  };
  await q("order", (l) => sql`select o.id, c.name, o.total_amount::text as amount, o.order_no as ref from orders o join customers c on c.id = o.customer_id where o.id in ${l}`);
  await q("payment", (l) => sql`select r.id, c.name, r.amount::text as amount, null as ref from payment_receipts r join customers c on c.id = r.customer_id where r.id in ${l}`);
  await q("credit_note", (l) => sql`select k.id, c.name, k.cn_amount::text as amount, null as ref from complaints k join customers c on c.id = k.customer_id where k.id in ${l}`);
  await q("order_change", (l) => sql`select q.id, c.name, q.total_amount_paise::text as amount, o.order_no as ref from order_change_requests q join customers c on c.id = q.customer_id join orders o on o.id = q.order_id where q.id in ${l}`);
  return out;
}

/** Open breaches, for the Founder sidebar's count. */
export async function openDeadlineCount(): Promise<number> {
  const [r] = await db.execute<{ n: number }>(sql`select count(*)::int as n from accounts_sla_breaches where resolved_at is null`);
  return Number(r?.n ?? 0);
}
