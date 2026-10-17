import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { moneyArrivingSql } from "@/lib/money-arriving";
import { type BusinessDate } from "@/lib/business-date";
import { readingsForPeriod } from "@/lib/services/performance-service";
import { ownerDashboard } from "@/lib/services/owner-dashboard-service";
import { companyPayload } from "./company";
import { inboxFor } from "./inbox";
import { crore, monthLong, num, plural, span } from "./format";
import type { PeriodState, SectionKey } from "./types";

/* ---------------------------------------------------------------------------
 * ASK THE COMPANY — "Answers are read from the figures on this dashboard".
 *
 * Deliberately NOT a language model inventing sentences about money: each
 * question is routed to the same reads the sections use, and the answer is
 * composed from what they return. A question it cannot route is answered with
 * the headline and an honest list of what it can answer.
 * ------------------------------------------------------------------------- */

export const ASK_SUGGESTIONS = [
  "Why did collections fall this month?",
  "Who is furthest behind their target?",
  "Which customers are slipping?",
  "What is waiting on me today?",
  "Are we on pace for this month?",
];

type Answer = { text: string; go: SectionKey; goLabel: string };

const has = (q: string, ...words: string[]) => words.some((w) => q.includes(w));

export async function ask(p: PeriodState, userId: string, question: string): Promise<Answer> {
  const q = question.toLowerCase();

  if (has(q, "collect", "payment", "money", "owe", "outstanding")) {
    const [cur, prev, reported, overdue] = await Promise.all([
      collected(p.from, p.to),
      collected(p.compareFrom, p.compareTo),
      db.execute<{ n: number; v: string }>(sql`select count(*)::int as n, coalesce(sum(amount),0)::text as v from payment_receipts where status = 'reported'`),
      db.execute<{ name: string; v: string }>(sql`
        select c.name, sum(b.amount - b.paid_amount)::text as v
          from bills b join customers c on c.id = b.customer_id
         where b.payment_position = 'stated' and b.amount > b.paid_amount and b.due_date < ${sql.raw(`'${p.today}'::date`)}
           and not exists (select 1 from payment_receipts r where r.customer_id = c.id and r.status = 'confirmed'
                            and r.received_at >= ${sql.raw(`'${p.from}'::date`)})
         group by c.id, c.name order by sum(b.amount - b.paid_amount) desc limit 1
      `),
    ]);
    const pct = prev ? ((cur - prev) / prev) * 100 : null;
    const rep = reported[0];
    const top = overdue[0];
    return {
      text:
        `Collected is ${crore(cur)} for ${span(p.from, p.to)}${pct == null ? " — nothing was collected in the comparison period" : `, ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% on ${span(p.compareFrom, p.compareTo)}`}.` +
        (rep && rep.n > 0 ? ` ${crore(Number(rep.v))} across ${plural(rep.n, "receipt")} is reported by the team but not yet confirmed by accounts, and does not count until it is.` : "") +
        (top ? ` The largest overdue balance with nothing paid this period is ${top.name}, owing ${crore(Number(top.v))}.` : ""),
      go: "money",
      goLabel: "Open Money",
    };
  }

  if (has(q, "behind", "target", "worst", "furthest", "score")) {
    const readings = (await readingsForPeriod(p.monthKey, p.today as BusinessDate, {})).filter((r) => r.hasTarget);
    if (!readings.length) return { text: `Nobody holds a published target for ${monthLong(p.monthKey)}, so nobody can be behind one.`, go: "team", goLabel: "Open Targets & performance" };
    const worst = [...readings].sort((a, b) => a.score.totalBp - b.score.totalBp)[0]!;
    const rev = worst.score.components.find((c) => c.key === "revenue");
    const left = worst.workingDaysTotal - worst.workingDaysElapsed;
    const alert = worst.alerts[0]?.message;
    return {
      text: `${worst.userName} has the lowest score for ${monthLong(p.monthKey)}: ${Math.round(worst.score.totalBp / 100)} out of 100${rev && rev.achievementBp != null ? `, at ${Math.round(rev.achievementBp / 100)}% of the revenue target` : ""}, with ${plural(left, "working day")} left.${alert ? ` ${alert}` : ""}`,
      go: "team",
      goLabel: "Open Targets & performance",
    };
  }

  if (has(q, "slip", "lapse", "customer", "retention", "health", "quiet")) {
    const o = await ownerDashboard({ from: p.from as BusinessDate, to: p.to as BusinessDate }, { from: p.compareFrom as BusinessDate, to: p.compareTo as BusinessDate }, { from: p.lastYearFrom as BusinessDate, to: p.lastYearTo as BusinessDate }, p.today as BusinessDate, {});
    const r = o.retention.counts;
    const prev = o.previousRetention?.counts;
    return {
      text: `${num(r["at-risk"])} customers are Slowing and ${num(r.dormant + r.lost)} have lapsed past twice their buying cycle.${prev ? ` ${num(Math.abs(r["at-risk"] - prev["at-risk"]))} ${r["at-risk"] >= prev["at-risk"] ? "more" : "fewer"} are Slowing than at the last month end.` : " There is no month-end snapshot yet to compare with."}`,
      go: "customers",
      goLabel: "Open Customers",
    };
  }

  if (has(q, "wait", "need", "today", "inbox", "decide")) {
    const items = (await inboxFor(userId)).filter((i) => !i.handed && !i.snoozed);
    const urgent = items.filter((i) => i.sev === "Urgent");
    return {
      text: items.length
        ? `${plural(items.length, "item")}, ${urgent.length} urgent${urgent.length ? `: ${urgent.slice(0, 3).map((i) => i.title.charAt(0).toLowerCase() + i.title.slice(1)).join("; ")}` : ""}.`
        : "Nothing is waiting on you. Items appear on their own when a rule fires.",
      go: "inbox",
      goLabel: "Open Needs you",
    };
  }

  const c = await companyPayload(p);
  if (has(q, "pace", "month", "forecast", "project", "on track")) {
    const f = c.pace.figures;
    return {
      text: c.pace.hasTarget
        ? `Projected ${f[0]!.value} against ${c.pace.rightLine.replace("Target ", "").replace(", excl. GST as targets are set", "")} of targets (excl. GST). It needs ${f[2]!.value} per working day, ${f[2]!.sub}.`
        : `Nobody holds a published target for ${monthLong(p.monthKey)}, so there is no pace to measure. Done so far: ${c.pace.leftLine.replace("Done ", "")}.`,
      go: "team",
      goLabel: "Open the pace",
    };
  }

  const rev = c.cards.find((x) => x.key === "rev")!;
  return {
    text: `Revenue is ${rev.value} for ${span(p.from, p.to)}${rev.chgGood === null ? `, with nothing to compare it with ${rev.prevLine.replace("vs ", "in the ")}` : `, ${rev.chg} ${rev.prevLine}`}. Ask about collections, targets, customers, the month's pace or what is waiting on you for more.`,
    go: "company",
    goLabel: "Open Company",
  };
}

async function collected(from: string, to: string) {
  const r = await db.execute<{ v: string }>(sql`
    select coalesce(sum(amount), 0)::text as v from payment_receipts
     where ${moneyArrivingSql("payment_receipts")}
       and received_at >= ${sql.raw(`'${from}'::date`)} and received_at <= ${sql.raw(`'${to}'::date`)}
  `);
  return Number(r[0]?.v ?? 0);
}
