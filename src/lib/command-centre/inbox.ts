import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { founderInboxMarks, users } from "@/db/schema";
import { type BusinessDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { orderCountsSql } from "@/lib/order-status";
import { creditedToSql } from "@/lib/sales-attribution";
import { today } from "@/lib/recompute";
import { workingDaysIn } from "@/lib/services/performance-service";
import { notifyUser } from "@/lib/notify";
import { crore, fmtDate, fmtDay, num, plural, waited } from "./format";
import { stampIST } from "./provider";
import type { InboxItem, InboxSeverity, SectionKey } from "./types";

/* ---------------------------------------------------------------------------
 * NEEDS YOU — every decision waiting on the founder and every alarm, derived
 * from live rules and never stored (PRD §8.2). An item appears when its
 * condition holds and leaves by itself when it clears. What IS stored is the
 * human half: a hand-off to a colleague, and a personal snooze.
 *
 * Every rule below reads the same table the owning desk works from, so an
 * item can never claim something the desk does not also see.
 * ------------------------------------------------------------------------- */

type Rule = Omit<InboxItem, "handed" | "snoozed">;

const one = async <T,>(q: Promise<T[]>): Promise<T | undefined> => (await q)[0];

async function rules(): Promise<Rule[]> {
  const config = await getConfig();
  const day = (await today()) as BusinessDate;
  const monthKey = day.slice(0, 7);
  const staleHours = config["payments.confirmationAgeWarningHours"];
  const out: Rule[] = [];

  const [
    priceReqs,
    waSwitch,
    waLive,
    reported,
    held,
    ordersWaiting,
    expiring,
    noFix,
    pastSla,
    unattributed,
    unmatched,
    unassignedEnq,
    creditNotes,
    statusReqs,
    failedRuns,
    approvals,
    remindersOverdue,
    hrSync,
    paceNet,
    paceTarget,
    days,
    quietHandsets,
  ] = await Promise.all([
    db.execute<{ n: number; oldest: string | null; name: string | null; asked: string | null; list: string | null; who: string | null }>(sql`
      select count(*) over ()::int as n, r.created_at::text as oldest, c.name,
             r.requested_rate_ex_gst_paise::text as asked, r.current_rate_ex_gst_paise::text as list, u.name as who
        from price_requests r join customers c on c.id = r.customer_id left join users u on u.id = r.requested_by_id
       where r.status = 'pending' order by r.created_at limit 1
    `),
    one(db.execute<{ active: boolean; at: string }>(sql`select active, at::text from whatsapp_service_events order by at desc limit 1`)),
    db.execute<{ n: number }>(sql`select count(*)::int as n from wa_triggers where status = 'live'`),
    one(db.execute<{ n: number; v: string; oldest: string | null }>(sql`
      select count(*)::int as n, coalesce(sum(amount), 0)::text as v, min(created_at)::text as oldest
        from payment_receipts where status = 'reported'
         and created_at < now() - make_interval(hours => ${staleHours})
    `)),
    one(db.execute<{ n: number; v: string; oldest: string | null }>(sql`
      select count(*)::int as n, coalesce(sum(amount), 0)::text as v, min(held_at)::text as oldest
        from payment_receipts where status = 'held'
         and held_at < now() - make_interval(days => ${config["payments.holdStaleDays"]})
    `)),
    one(db.execute<{ n: number; v: string; oldest: string | null }>(sql`
      select count(*)::int as n, coalesce(sum(total_amount), 0)::text as v, min(created_at)::text as oldest
        from orders where status = 'pending_approval'
    `)),
    db.execute<{ id: string; name: string; ref: string | null; to: string; shops: number }>(sql`
      select l.id, l.name, l.ref_no as ref, l.effective_to::text as to, 0 as shops
        from price_lists l
       where l.status = 'published' and l.effective_to is not null
         and l.effective_to between ${sql.raw(`'${day}'::date`)} and ${sql.raw(`'${day}'::date + 7`)}
         and not exists (select 1 from price_lists n where n.supersedes_id = l.id and n.status in ('published','scheduled'))
       order by l.effective_to limit 5
    `),
    db.execute<{ name: string; at: string }>(sql`
      select u.name, a.check_in_at::text as at
        from mbos_attendance_days a join users u on u.id = a.user_id
       where a.day = ${sql.raw(`'${day}'::date`)} and a.check_in_at is not null and a.check_in_lat is null
       order by a.check_in_at
    `),
    db.execute<{ n: number; name: string; category: string; hours: number }>(sql`
      select count(*) over ()::int as n, c.name, k.category,
             extract(epoch from (now() - k.created_at)) / 3600 as hours
        from complaints k join customers c on c.id = k.customer_id
       where k.status in ('open','in_progress','awaiting_customer') and k.sla_due_at < now()
       order by k.created_at limit 1
    `),
    one(db.execute<{ v: string; n: number }>(sql`
      select coalesce(sum(o.total_amount), 0)::text as v, count(distinct o.customer_id)::int as n
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")} and ${creditedToSql("c")} is null
         and o.ordered_at >= ${sql.raw(`'${monthKey}-01 00:00:00+05:30'::timestamptz`)}
    `)),
    one(db.execute<{ n: number }>(sql`select count(*)::int as n from wa_replies where customer_id is null and actioned = false`)),
    one(db.execute<{ n: number; oldest: string | null }>(sql`
      select count(*)::int as n, min(received_at)::text as oldest from enquiries
       where assigned_to_id is null and stage not in ('converted','closed','lost','spam')
    `)).catch(() => undefined),
    one(db.execute<{ n: number; oldest: string | null }>(sql`
      select count(*)::int as n, min(created_at)::text as oldest from complaints
       where request_cn = true and coalesce(cn_status, 'requested') = 'requested'
    `)),
    one(db.execute<{ n: number; close: number; open: number }>(sql`
      select count(*)::int as n,
             count(*) filter (where deactivation_requested)::int as close,
             count(*) filter (where reactivation_requested)::int as open
        from customers where deactivation_requested or reactivation_requested
    `)),
    db.execute<{ what: string; at: string; detail: string | null }>(sql`
      (select job as what, started_at::text as at, detail from job_runs
        where ok = false and started_at > now() - interval '24 hours')
      union all
      (select source::text || ' · ' || coalesce(mode::text, '') as what, started_at::text as at, error as detail from sheet_sync_runs
        where status = 'failed' and started_at > now() - interval '24 hours')
      order by at desc limit 5
    `),
    db.execute<{ type: string; n: number; oldest: string }>(sql`
      select type::text as type, count(*)::int as n, min(requested_at)::text as oldest
        from mbos_approvals where state = 'pending' group by type
    `),
    one(db.execute<{ n: number; people: number }>(sql`
      select count(*)::int as n, count(distinct assigned_user_id)::int as people from reminders
       where status = 'pending' and due_date < ${sql.raw(`'${day}'::date`)} - ${config["dashboard.reminderOverdueFlagDays"]}::int
    `)),
    one(db.execute<{ at: string | null }>(sql`
      select max(finished_at)::text as at from sheet_sync_runs where source = 'employees' and status in ('ok','succeeded','success','done')
    `)).catch(() => undefined),
    one(db.execute<{ v: string }>(sql`
      select coalesce(sum(coalesce(o.net_amount_paise, o.total_amount)), 0)::text as v
        from orders o join customers c on c.id = o.customer_id
       where ${orderCountsSql("o")} and ${creditedToSql("c")} is not null
         and o.ordered_at >= ${sql.raw(`'${monthKey}-01 00:00:00+05:30'::timestamptz`)}
    `)),
    one(db.execute<{ v: string }>(sql`
      select coalesce(sum(revenue_target_paise), 0)::text as v from sales_targets
       where period = ${monthKey} and status = 'published'
    `)),
    workingDaysIn(monthKey, day),
    one(db.execute<{ n: number }>(sql`
      select count(*)::int as n from mbos_devices d
       where d.active and d.last_seen_at < now() - make_interval(hours => 4)
         and exists (select 1 from mbos_attendance_days a where a.user_id = d.user_id and a.day = ${sql.raw(`'${day}'::date`)} and a.check_out_at is null)
    `)).catch(() => undefined),
  ]);

  const since = (at: string | null | undefined) => {
    if (!at) return "now";
    const d = at.slice(0, 10);
    if (d === day) return `Today, ${stampIST(at).split(", ")[1]?.replace(" IST", "") ?? ""}`;
    return fmtDay(d);
  };

  /* ---- decisions only the founder (or a desk) takes ---- */
  if (priceReqs[0]) {
    const r = priceReqs[0];
    const asked = Number(r.asked ?? 0);
    const list = Number(r.list ?? 0);
    const gap = list > 0 ? ((list - asked) / list) * 100 : null;
    out.push({
      id: "price-requests",
      sev: "Urgent",
      area: "Price lists",
      since: since(r.oldest),
      title: `${plural(r.n, "special price request")} ${r.n === 1 ? "is" : "are"} waiting on you`,
      why: `Oldest is ${r.name ?? "a customer"} asking ${crore(asked)} against a list rate of ${list ? crore(list) : "no list rate"}${gap != null ? ` — ${gap.toFixed(1)}% ${gap >= 0 ? "below" : "above"}` : ""}. Raised by ${r.who ?? "somebody"}.`,
      action: "Decide",
      go: "prices",
    });
  }

  const liveN = Number(waLive[0]?.n ?? 0);
  if (liveN > 0 && waSwitch && !waSwitch.active) {
    out.push({
      id: "wa-live-switch-off",
      sev: "Urgent",
      area: "WhatsApp",
      since: since(waSwitch.at),
      title: `${plural(liveN, "Live rule")} ${liveN === 1 ? "is" : "are"} not sending`,
      why: `${liveN === 1 ? "A rule is" : `${num(liveN)} rules are`} Live, but the WhatsApp switch is OFF, so nothing automated goes out.`,
      action: "Open WhatsApp",
      go: "whatsapp",
    });
  }

  if (reported && reported.n > 0) {
    out.push({
      id: "receipts-reported-stale",
      sev: "Urgent",
      area: "Money",
      since: since(reported.oldest),
      title: `Payments reported and not confirmed for ${waited((Date.now() - new Date(reported.oldest ?? Date.now()).getTime()) / 3_600_000)}`,
      why: `${crore(Number(reported.v))} across ${plural(reported.n, "receipt")} has been reported and not found by accounts. Those customers are not being chased meanwhile.`,
      action: "Decide them",
      go: "money",
    });
  }

  if (failedRuns.length) {
    out.push({
      id: `runs-failed`,
      sev: "Urgent",
      area: "System",
      since: since(failedRuns[0]!.at),
      title: `${plural(failedRuns.length, "sync or job")} failed in the last 24 hours`,
      why: `${failedRuns.map((f) => f.what).slice(0, 3).join(", ")}${failedRuns[0]!.detail ? ` — ${String(failedRuns[0]!.detail).slice(0, 140)}` : ""}.`,
      action: "Open system health",
      go: "system",
    });
  }

  if (ordersWaiting && ordersWaiting.n > 0) {
    const hours = (Date.now() - new Date(ordersWaiting.oldest ?? Date.now()).getTime()) / 3_600_000;
    out.push({
      id: "orders-pending",
      sev: hours > 48 ? "Urgent" : "Soon",
      area: "Sales",
      since: since(ordersWaiting.oldest),
      title: `${plural(ordersWaiting.n, "order")} ${ordersWaiting.n === 1 ? "is" : "are"} waiting on approval`,
      why: `${crore(Number(ordersWaiting.v))} of orders the customer has said yes to and accounts has not decided. The oldest has waited ${waited(hours)}.`,
      action: "Decide them",
      go: "sales",
    });
  }

  for (const l of expiring) {
    out.push({
      id: `list-expiring-${l.id}`,
      sev: "Soon",
      area: "Price lists",
      since: fmtDay(day),
      title: `${l.name} expires on ${fmtDate(l.to)}`,
      why: `Published list ${l.ref ?? ""} expires ${l.to === day ? "today" : `on ${fmtDate(l.to)}`} and nothing supersedes it yet.`,
      action: "Publish a new version",
      go: "prices",
    });
  }

  const target = Number(paceTarget?.v ?? 0);
  if (target > 0 && days.elapsed > 0) {
    const done = Number(paceNet?.v ?? 0);
    const projected = (done / days.elapsed) * days.total;
    const pct = Math.round((projected / target) * 100);
    if (pct < 90) {
      out.push({
        id: `pace-${monthKey}`,
        sev: "Soon",
        area: "Team",
        since: "This month",
        title: "Company revenue is behind pace",
        why: `Projected ${crore(projected)} against ${crore(target)} of published targets — ${pct}%, below the 90% warning line. ${plural(days.total - days.elapsed, "working day")} left.`,
        action: "Open the team",
        go: "team",
      });
    }
  }

  if (noFix.length) {
    out.push({
      id: `no-gps-${day}`,
      sev: "Soon",
      area: "Field force",
      since: since(noFix[0]!.at),
      title: `${plural(noFix.length, "salesman", "salesmen")} checked in with no GPS fix`,
      why: `${noFix.slice(0, 3).map((n) => n.name).join(", ")}${noFix.length > 3 ? ` and ${noFix.length - 3} more` : ""} checked in without a location. Their visits today cannot be verified against it.`,
      action: "Open field force",
      go: "field",
    });
  }

  if (pastSla[0]) {
    const k = pastSla[0];
    out.push({
      id: "complaints-past-sla",
      sev: "Soon",
      area: "Service",
      since: `${Math.round(k.hours)} h`,
      title: `${plural(k.n, "complaint")} ${k.n === 1 ? "is" : "are"} past ${k.n === 1 ? "its" : "their"} SLA`,
      why: `Oldest is ${k.name}, ${String(k.category).replace(/_/g, " ")}, open ${Math.round(k.hours)} hours.`,
      action: "Open the complaints",
      go: "service",
    });
  }

  if (creditNotes && creditNotes.n > 0) {
    out.push({
      id: "credit-notes-waiting",
      sev: "Soon",
      area: "Money",
      since: since(creditNotes.oldest),
      title: `${plural(creditNotes.n, "credit note request")} waiting`,
      why: "Customers asked for a credit note on a complaint and nobody has issued or refused it.",
      action: "Open Money",
      go: "money",
    });
  }

  for (const a of approvals) {
    const words: Record<string, [string, SectionKey]> = {
      leave: ["leave request", "field"],
      expense: ["expense claim", "field"],
      regularisation: ["attendance correction", "field"],
      tour: ["tour request", "field"],
      sample: ["sample request", "leads"],
      distributor_appointment: ["distributor appointment", "leads"],
      order: ["field order", "sales"],
    };
    const [noun, go] = words[a.type] ?? [a.type.replace(/_/g, " ") + " approval", "field"];
    out.push({
      id: `approvals-${a.type}`,
      sev: "Soon",
      area: go === "leads" ? "Leads" : go === "sales" ? "Sales" : "Field force",
      since: since(a.oldest),
      title: `${plural(a.n, noun)} waiting on a decision`,
      why: `Raised from the handset and not yet decided. The oldest has waited ${waited((Date.now() - new Date(a.oldest).getTime()) / 3_600_000)}.`,
      action: "Open them",
      go,
    });
  }

  if (unassignedEnq && unassignedEnq.n > 0) {
    out.push({
      id: "enquiries-unassigned",
      sev: "Soon",
      area: "Enquiries",
      since: since(unassignedEnq.oldest),
      title: `${plural(unassignedEnq.n, "website enquiry", "website enquiries")} with nobody on ${unassignedEnq.n === 1 ? "it" : "them"}`,
      why: "Nobody has been assigned to follow them up, so nobody will.",
      action: "Assign them",
      go: "enquiries",
    });
  }

  /* ---- things to watch ---- */
  if (unattributed && Number(unattributed.v) > 0) {
    out.push({
      id: `unattributed-${monthKey}`,
      sev: "Watch",
      area: "Sales",
      since: "This month",
      title: `${crore(Number(unattributed.v))} of revenue is not counted towards anybody`,
      why: `${plural(unattributed.n, "customer")} who ordered this month ${unattributed.n === 1 ? "has" : "have"} no salesperson and no back-office person.`,
      action: "Open the customers",
      go: "customers",
    });
  }

  if (held && held.n > 0) {
    out.push({
      id: "receipts-held-stale",
      sev: "Watch",
      area: "Money",
      since: since(held.oldest),
      title: `${plural(held.n, "held payment")} ${held.n === 1 ? "has" : "have"} been held a long time`,
      why: `${crore(Number(held.v))} is on hold while accounts looks for it in the bank. Held customers are not chased.`,
      action: "Open Money",
      go: "money",
    });
  }

  if (statusReqs && statusReqs.n > 0) {
    out.push({
      id: "status-requests",
      sev: "Watch",
      area: "Customers",
      since: "Waiting",
      title: `${plural(statusReqs.n, "account status request")} waiting`,
      why: `${plural(statusReqs.close, "request")} to close an account and ${plural(statusReqs.open, "request")} to reopen one. Nothing changes until somebody decides.`,
      action: "Open the customers",
      go: "customers",
    });
  }

  if (remindersOverdue && remindersOverdue.n > 0) {
    out.push({
      id: "reminders-overdue",
      sev: "Watch",
      area: "Calling",
      since: "Now",
      title: `${plural(remindersOverdue.n, "reminder")} more than ${config["dashboard.reminderOverdueFlagDays"]} days overdue`,
      why: `Across ${plural(remindersOverdue.people, "person", "people")}. Each is a promise made to a customer that has not been kept.`,
      action: "Open calling",
      go: "calling",
    });
  }

  const hrAt = hrSync?.at ?? null;
  const hrHours = hrAt ? (Date.now() - new Date(hrAt).getTime()) / 3_600_000 : null;
  if (hrHours == null || hrHours > 24) {
    out.push({
      id: "hr-sheet-stale",
      sev: "Watch",
      area: "System",
      since: hrAt ? fmtDay(hrAt.slice(0, 10)) : "never",
      title: hrAt ? `The HR sheet has not synced for ${waited(hrHours ?? 0)}` : "The HR sheet has never been read",
      why: hrAt
        ? `Headcount and joiners are as of ${fmtDate(hrAt.slice(0, 10))}. The sheet only syncs when HRMS is opened.`
        : "Headcount, joiners and leavers cannot be counted until it is read once.",
      action: "Open system health",
      go: "system",
    });
  }

  if (quietHandsets && quietHandsets.n > 0) {
    out.push({
      id: `handsets-quiet-${day}`,
      sev: "Watch",
      area: "Field force",
      since: "Today",
      title: `${plural(quietHandsets.n, "handset")} quiet for more than 4 hours`,
      why: "Checked in today and not heard from since. The office cannot see where they are or what they have done.",
      action: "Open field force",
      go: "field",
    });
  }

  if (unmatched && unmatched.n > 0) {
    out.push({
      id: "wa-unmatched-replies",
      sev: "Watch",
      area: "WhatsApp",
      since: "Waiting",
      title: `${plural(unmatched.n, "unmatched WhatsApp reply", "unmatched WhatsApp replies")}`,
      why: "Replies from numbers on no customer. They are kept, not dropped, until attached.",
      action: "Attach them",
      go: "whatsapp",
    });
  }

  const order: Record<InboxSeverity, number> = { Urgent: 0, Soon: 1, Watch: 2 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

/** The inbox as this viewer sees it, with their hand-offs and snoozes. */
export const inboxFor = cache(async function inboxFor(userId: string): Promise<InboxItem[]> {
  const [items, marks, day] = await Promise.all([
    rules(),
    db
      .select({
        itemKey: founderInboxMarks.itemKey,
        kind: founderInboxMarks.kind,
        note: founderInboxMarks.note,
        until: founderInboxMarks.untilDate,
        why: founderInboxMarks.why,
        toName: users.name,
      })
      .from(founderInboxMarks)
      .leftJoin(users, eq(users.id, founderInboxMarks.toUserId))
      .where(eq(founderInboxMarks.userId, userId)),
    today(),
  ]);
  const byKey = new Map(marks.map((m) => [m.itemKey, m]));
  return items.map((i) => {
    const m = byKey.get(i.id);
    if (!m) return i;
    if (m.kind === "handed") return { ...i, handed: { to: m.toName ?? "a colleague", note: m.note ?? "" } };
    // A snooze that has run out is over: the item is back.
    if (m.kind === "snoozed" && m.until && m.until > day) return { ...i, snoozed: { until: fmtDate(m.until), why: m.why ?? "" } };
    return i;
  });
});

export async function handOn(userId: string, fromName: string, item: InboxItem, toUserId: string, note: string) {
  await db
    .insert(founderInboxMarks)
    .values({ id: `fim_${randomUUID().slice(0, 12)}`, userId, itemKey: item.id, kind: "handed", toUserId, note: note || null })
    .onConflictDoUpdate({
      target: [founderInboxMarks.userId, founderInboxMarks.itemKey],
      set: { kind: "handed", toUserId, note: note || null, untilDate: null, why: null, createdAt: new Date() },
    });
  // The colleague is told, with the item's own words — a hand-off nobody
  // receives is not a hand-off (lib/notify.ts).
  await notifyUser({
    userId: toUserId,
    title: `${fromName} handed you: ${item.title}`,
    body: `${item.why}${note ? `\n\nNote: ${note}` : ""}`,
    kind: item.sev === "Urgent" ? "warn" : "info",
    href: null,
  });
}

export async function snooze(userId: string, itemKey: string, until: string, why: string) {
  await db
    .insert(founderInboxMarks)
    .values({ id: `fim_${randomUUID().slice(0, 12)}`, userId, itemKey, kind: "snoozed", untilDate: until, why })
    .onConflictDoUpdate({
      target: [founderInboxMarks.userId, founderInboxMarks.itemKey],
      set: { kind: "snoozed", untilDate: until, why, toUserId: null, note: null, createdAt: new Date() },
    });
}

export async function clearMark(userId: string, itemKey: string) {
  await db
    .delete(founderInboxMarks)
    .where(and(eq(founderInboxMarks.userId, userId), eq(founderInboxMarks.itemKey, itemKey)));
}
