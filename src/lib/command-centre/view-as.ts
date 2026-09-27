import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { queueSnapshots } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { buildQueue, type QueueCandidate, type QueueResult } from "@/lib/engines/queue";
import { queueCandidatesFor } from "@/lib/services/queue-service";
import { getPaymentFollowUpPlan } from "@/lib/services/payment-service";
import { today } from "@/lib/recompute";
import { APP_TIMEZONE, type BusinessDate } from "@/lib/business-date";
import { num, plural } from "./format";
import type { ViewAs } from "./types";

/* ---------------------------------------------------------------------------
 * VIEW AS A PERSON, READ-ONLY (PRD §6.6).
 *
 * A telecaller's Call Log is the queue engine's answer for THEIR book — the
 * same `queueCandidatesFor` the nightly snapshot job reads, the same
 * `buildQueue`, the same collections verdict folded in — laid over the day's
 * settled list in `queue_snapshots` exactly as `settleDayList` lays it.
 *
 * It is READ-ONLY in the strict sense, and that is the one difference from
 * the Call Log itself: the Call Log's first read of the day WRITES the
 * snapshot, and a founder looking must not be what fixes the composition of
 * somebody else's day. Where nothing is settled yet, the live ranking is
 * shown and the list label says so.
 *
 * A salesman's day is his journey plan for today, the visits against it and
 * the off-plan ones beside it, read from the same tables the Sales Dashboard
 * and the handset read.
 * ------------------------------------------------------------------------- */

const IST = sql.raw(`at time zone '${APP_TIMEZONE}'`);

export type TelecallerQueueRow = {
  customerId: string;
  name: string;
  why: string;
  tag: "Worked" | "Now" | "";
};

export type TelecallerQueue = {
  userId: string;
  day: BusinessDate;
  /** Customers on today's list called today. */
  worked: number;
  /** Rows still callable — what the Call Log lists. */
  stillToWork: number;
  total: number;
  percent: number;
  /** Held back, with the engine's reason — never the ones already called. */
  held: { customerId: string; name: string; reason: string }[];
  rows: TelecallerQueueRow[];
  /** False when the day's list has not been settled yet. */
  settled: boolean;
};

type PaymentDue = Map<string, { totalOverdue: number; daysOverdue: number }>;

/**
 * The collections engine's "call today" verdict, company-wide, read once and
 * shared by every telecaller's queue in one request.
 */
export async function paymentCallsDueToday(): Promise<PaymentDue | null> {
  const config = await getConfig();
  if (!config["queue.includePaymentDue"]) return null;
  const plan = await getPaymentFollowUpPlan();
  return new Map(
    plan.calls.map((c) => [c.customerId, { totalOverdue: c.totalOverdue, daysOverdue: c.daysOverdue }]),
  );
}

/** One telecaller's Call Log for today, as they see it, without writing anything. */
export async function telecallerQueue(
  userId: string,
  opts?: { day?: BusinessDate; paymentDue?: PaymentDue | null },
): Promise<TelecallerQueue> {
  const day = opts?.day ?? (await today());
  const [config, candidates, stored, paymentDue] = await Promise.all([
    getConfig(),
    queueCandidatesFor(userId, day),
    db
      .select()
      .from(queueSnapshots)
      .where(and(eq(queueSnapshots.day, day), eq(queueSnapshots.userId, userId)))
      .orderBy(asc(queueSnapshots.rank)),
    opts?.paymentDue !== undefined ? Promise.resolve(opts.paymentDue) : paymentCallsDueToday(),
  ]);

  if (paymentDue) {
    for (const c of candidates) c.paymentCallDue = paymentDue.get(c.customerId) ?? null;
  }

  const live = buildQueue(candidates, day, config, Date.now());
  const byId = new Map<string, QueueCandidate>(candidates.map((c) => [c.customerId, c]));
  const liveById = new Map(live.entries.map((e) => [e.customerId, e]));
  const heldById = new Map(live.suppressed.map((h) => [h.customerId, h]));
  const worked = candidates.filter((c) => c.calledToday).length;
  const limit = config["queue.maxSizePerUser"];

  let entries: QueueResult["entries"];
  let suppressed: QueueResult["suppressed"];
  let ordered: { customerId: string; name: string; why: string; calledToday: boolean; live: boolean }[];

  if (!stored.length) {
    entries = live.entries;
    suppressed = live.suppressed;
    // Nothing settled: the called-today ones have no rank, so they head the
    // list as done, and the live ranking follows.
    ordered = [
      ...candidates
        .filter((c) => c.calledToday)
        .map((c) => ({ customerId: c.customerId, name: c.name, why: "Called today", calledToday: true, live: false })),
      ...live.entries.map((e) => ({
        customerId: e.customerId,
        name: e.name,
        why: e.reasons[0]?.label ?? "",
        calledToday: false,
        live: true,
      })),
    ];
  } else {
    // The settled list, rebuilt exactly as `settleDayList` rebuilds it.
    entries = [];
    suppressed = live.suppressed.filter((h) => !liveById.has(h.customerId));
    ordered = [];
    const settledIds = new Set(stored.map((r) => r.customerId));
    const promises = live.entries.filter(
      (e) =>
        !settledIds.has(e.customerId) &&
        e.reasons.some((r) => r.kind === "reminderDueToday" || r.kind === "reminderOverdue"),
    );
    for (const p of promises) {
      ordered.push({ customerId: p.customerId, name: p.name, why: p.reasons[0]?.label ?? "", calledToday: false, live: true });
    }
    for (const row of stored) {
      const c = byId.get(row.customerId);
      if (!c) continue;
      const why = row.reasons[0]?.label ?? liveById.get(row.customerId)?.reasons[0]?.label ?? "";
      const stillLive = liveById.get(row.customerId);
      if (stillLive) {
        entries.push(stillLive);
        ordered.push({ customerId: c.customerId, name: c.name, why, calledToday: false, live: true });
        continue;
      }
      if (!suppressed.some((h) => h.customerId === row.customerId)) {
        suppressed.push({
          customerId: row.customerId,
          name: c.name,
          reason: heldById.get(row.customerId)?.reason ?? "Dealt with since the list was settled",
        });
      }
      if (c.calledToday) {
        ordered.push({ customerId: c.customerId, name: c.name, why, calledToday: true, live: false });
      }
    }
    entries.unshift(...promises);
  }

  const totalQualified = entries.length;
  const callable = limit > 0 ? entries.slice(0, limit) : entries;
  const callableIds = new Set(callable.map((e) => e.customerId));
  const total = totalQualified + worked;

  let nowGiven = false;
  const rows: TelecallerQueueRow[] = [];
  for (const o of ordered) {
    if (o.live && !callableIds.has(o.customerId)) continue;
    let tag: TelecallerQueueRow["tag"] = "";
    if (o.calledToday) tag = "Worked";
    else if (!nowGiven) {
      tag = "Now";
      nowGiven = true;
    }
    rows.push({ customerId: o.customerId, name: o.name, why: o.why, tag });
  }

  return {
    userId,
    day,
    worked,
    stillToWork: callable.length,
    total,
    percent: total ? Math.round((worked / total) * 100) : 0,
    held: suppressed.filter((h) => !byId.get(h.customerId)?.calledToday),
    rows,
    settled: stored.length > 0,
  };
}

/** The engine's held-back reasons, grouped into a sentence a person reads. */
export function heldSentence(
  held: { reason: string }[],
  whatsappCooldownDays: number,
): string {
  if (!held.length) return "Nobody is held back today.";
  const groups = new Map<string, number>();
  for (const h of held) {
    const r = h.reason;
    const g = /^WhatsApp sent/.test(r)
      ? `messaged on WhatsApp in the last ${plural(whatsappCooldownDays, "day")}`
      : /^Skipped today/.test(r)
        ? "skipped today"
        : /^Marked do not contact/.test(r)
          ? "marked do not contact"
          : /^Active in the order system/.test(r)
            ? "with an order still open on the order sheet"
            : /^No answer/.test(r)
              ? "waiting before the next try after no answer"
              : /^Holding other calls/.test(r)
                ? "held for a callback they were promised"
                : /lead funnel/.test(r)
                  ? "being worked on the sales team's lead funnel"
                  : /^Orders every .*ordered/.test(r)
                    ? "who ordered recently"
                    : /no order chased/.test(r)
                      ? "who told us no recently"
                      : /^Dealt with since/.test(r)
                        ? "dealt with since the list was settled"
                        : r.split(" - ")[0]!.toLowerCase();
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  const parts = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${num(n)} ${g}`);
  return `${plural(held.length, "customer")} ${held.length === 1 ? "is" : "are"} held back today: ${parts.join(", ")}.`;
}

/* ------------------------------------------------------------ salesman */

type StopRow = {
  stop_id: string;
  sequence: number;
  status: "planned" | "visited" | "skipped";
  skip_reason: string | null;
  planned_at: string | null;
  customer_name: string;
  city: string | null;
  visit_at: string | null;
  verified: boolean | null;
  unverified_reason: string | null;
  distance_m: number | null;
  open_visit: boolean | null;
};

type OffPlanRow = {
  id: string;
  customer_name: string;
  check_in_at: string;
  check_out_at: string | null;
  verified: boolean;
  deviation_reason: string | null;
  unverified_reason: string | null;
  distance_m: number | null;
};

const CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: APP_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function clock(at: string | Date | null): string {
  if (!at) return "";
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? "" : CLOCK.format(d);
}

function unverifiedLine(reason: string | null, distance: number | null): string {
  if (distance != null) return `checked in ${num(distance)} m from the shop's recorded address`;
  return reason ? reason.charAt(0).toLowerCase() + reason.slice(1) : "saved without the location check";
}

export async function salesmanDay(userId: string, day?: BusinessDate) {
  const on = day ?? (await today());
  const [stops, offPlan, counts] = await Promise.all([
    db.execute<StopRow>(sql`
      select s.id as stop_id, s.sequence, s.status, s.skip_reason, s.planned_at,
             c.name as customer_name, c.city,
             v.check_in_at as visit_at, v.verified, v.unverified_reason,
             v.distance_from_shop_m as distance_m,
             (v.id is not null and v.check_out_at is null) as open_visit
        from mbos_journey_stops s
        join mbos_journey_plans p on p.id = s.plan_id
        join customers c on c.id = s.customer_id
        left join lateral (
          select * from mbos_visits v
           where v.journey_plan_stop_id = s.id
           order by v.check_in_at desc nulls last limit 1
        ) v on true
       where p.user_id = ${userId} and p.plan_date = ${on}::date
       order by s.sequence asc
    `),
    db.execute<OffPlanRow>(sql`
      select v.id, c.name as customer_name, v.check_in_at, v.check_out_at, v.verified,
             v.deviation_reason, v.unverified_reason, v.distance_from_shop_m as distance_m
        from mbos_visits v
        join customers c on c.id = v.customer_id
       where v.salesman_id = ${userId}
         and (v.check_in_at ${IST})::date = ${on}::date
         and v.journey_plan_stop_id is null
       order by v.check_in_at asc
    `),
    db.execute<{ visits: number; verified: number; orders: number }>(sql`
      select
        (select count(*)::int from mbos_visits v where v.salesman_id = ${userId}
          and (v.check_in_at ${IST})::date = ${on}::date) as visits,
        (select count(*)::int from mbos_visits v where v.salesman_id = ${userId}
          and (v.check_in_at ${IST})::date = ${on}::date and v.verified) as verified,
        (select count(*)::int from orders o where o.created_by_id = ${userId} and o.source = 'mbos'
          and (o.ordered_at ${IST})::date = ${on}::date) as orders
    `),
  ]);
  return { day: on, stops: [...stops], offPlan: [...offPlan], counts: counts[0] ?? { visits: 0, verified: 0, orders: 0 } };
}

/* ------------------------------------------------------------- the view */

async function personOf(userId: string) {
  const rows = await db.execute<{ name: string; apps: string[] }>(sql`
    select u.name, coalesce(array_agg(a.app::text) filter (where a.app is not null), '{}') as apps
      from users u left join app_access a on a.user_id = u.id
     where u.id = ${userId}
     group by u.id
  `);
  return rows[0] ?? null;
}

export async function viewAsPerson(
  userId: string,
  kind: "caller" | "salesman" | "auto",
): Promise<ViewAs> {
  const person = await personOf(userId);
  if (!person) throw new Error("That person is not in MahekOne.");
  const apps = person.apps ?? [];
  const as =
    kind !== "auto" ? kind : apps.includes("field") && !apps.includes("crm") ? "salesman" : "caller";

  if (as === "caller") {
    const day = await today();
    const [q, config, due] = await Promise.all([
      telecallerQueue(userId, { day }),
      getConfig(),
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from reminders r
         where r.assigned_user_id = ${userId} and r.status = 'pending'
           and r.due_date <= ${day}::date
      `),
    ]);
    return {
      name: person.name,
      role: "Telecaller · their Call Log exactly as they see it",
      stats: [
        { l: "In the queue", v: num(q.stillToWork) },
        { l: "Worked", v: num(q.worked) },
        { l: "Reminders due", v: num(Number(due[0]?.n ?? 0)) },
        { l: "Held back", v: num(q.held.length) },
      ],
      held: heldSentence(q.held, config["queue.whatsappCooldownDays"]),
      listLabel: q.settled
        ? "Their call log, in order"
        : "Their call log, in order · not opened yet today, so this is the live ranking their first look will settle",
      rows: q.rows.map((r, i) => ({
        n: String(i + 1),
        name: r.name,
        why: r.why,
        tag: r.tag,
        tagTone: r.tag === "Now" ? "now" : r.tag === "Worked" ? "done" : "",
      })),
    };
  }

  const d = await salesmanDay(userId);
  const visitedStops = d.stops.filter((s) => s.status === "visited").length;
  const unverified: string[] = [];
  const rows: ViewAs["rows"] = [];
  let nowGiven = false;
  for (const s of d.stops) {
    const planned = s.planned_at ? `Planned ${clock(s.planned_at)}` : `Stop ${s.sequence}`;
    let why = planned;
    let tag = "";
    let tagTone: "now" | "done" | "" = "";
    if (s.status === "visited" || s.visit_at) {
      const v = s.verified === false ? `unverified, ${unverifiedLine(s.unverified_reason, s.distance_m)}` : "verified";
      why = `${planned} · visited ${clock(s.visit_at)}${s.visit_at ? ` · ${v}` : ""}`;
      if (s.open_visit && !nowGiven) {
        tag = "Now";
        tagTone = "now";
        nowGiven = true;
      } else {
        tag = "Visited";
        tagTone = "done";
      }
      if (s.visit_at && s.verified === false) unverified.push(unverifiedLine(s.unverified_reason, s.distance_m));
    } else if (s.status === "skipped") {
      why = `${planned} · skipped${s.skip_reason ? ` · ${s.skip_reason}` : ""}`;
    } else {
      why = `${planned}${s.city ? ` · ${s.city}` : ""}`;
    }
    rows.push({ n: String(s.sequence), name: s.customer_name, why, tag, tagTone });
  }
  // The first stop still to walk is where he is heading, if nothing is open.
  if (!nowGiven) {
    const next = d.stops.findIndex((s) => s.status === "planned" && !s.visit_at);
    if (next >= 0) {
      rows[next] = { ...rows[next]!, tag: "Now", tagTone: "now" };
    }
  }
  for (const v of d.offPlan) {
    const state = v.verified ? "verified" : `unverified, ${unverifiedLine(v.unverified_reason, v.distance_m)}`;
    if (!v.verified) unverified.push(unverifiedLine(v.unverified_reason, v.distance_m));
    rows.push({
      n: "·",
      name: v.customer_name,
      why: `Off-plan · ${clock(v.check_in_at)} · ${v.deviation_reason ? `reason given: ${v.deviation_reason}` : "no reason given"} · ${state}`,
      tag: v.check_out_at ? "Visited" : "Now",
      tagTone: v.check_out_at ? "done" : "now",
    });
  }

  const visits = Number(d.counts.visits);
  const held = !visits
    ? d.stops.length
      ? "No visit has been logged today yet."
      : "No route is planned for today and no visit has been logged."
    : !unverified.length
      ? `Every visit today is verified (${plural(visits, "visit")}).`
      : unverified.length === 1
        ? `1 visit is unverified: ${unverified[0]}.`
        : `${num(unverified.length)} visits are unverified: ${unverified.slice(0, 3).join("; ")}${unverified.length > 3 ? "; and more" : ""}.`;

  return {
    name: person.name,
    role: "Field salesman · their day on the handset exactly as they see it",
    stats: [
      { l: "Stops planned", v: num(d.stops.length) },
      { l: "Visited", v: num(visitedStops) },
      { l: "Verified", v: num(Number(d.counts.verified)) },
      { l: "Orders", v: num(Number(d.counts.orders)) },
    ],
    held,
    listLabel: d.stops.length ? "Their route today" : "Their visits today · no route was planned",
    rows,
  };
}
