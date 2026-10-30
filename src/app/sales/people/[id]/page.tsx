import { notFound } from "next/navigation";
import { performance, salesmanRecord } from "@/lib/services/sales-service";
import { dayEvidence } from "@/lib/services/day-evidence-service";
import { getSetting } from "@/lib/config/store";
import { endOfMonth } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { hometownTree } from "@/lib/services/hometown-service";
import { readingsForPeriod, type PerformanceReading } from "@/lib/services/performance-service";
import { SalesmanScreen, type ScoreFigures } from "./salesman-screen";

export const metadata = { title: "Salesman — Sales Dashboard — MahekOne" };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const now = await today();

  /* A day in the URL opens the Day check tab on it. Validated rather than
     trusted: it is spliced into a date cast, and an unparseable one would
     throw where the honest answer is today. */
  const asked = /^\d{4}-\d{2}-\d{2}$/.test(query.day ?? "") ? query.day! : null;
  const day = asked ?? now;

  /* This month and the one before it, from the SAME function the team's
     Performance screen reads. Not a query of its own: a figure on a person's
     record and the same figure on the team list have to come from one place,
     or the two screens disagree about what somebody did and there is no way to
     tell which is right. It returns the whole team and this picks one row —
     wasteful on a large team, correct on every team, and the alternative is a
     second spelling of twenty subqueries. */
  const thisMonth = now.slice(0, 7);
  const lastMonth = new Date(`${thisMonth}-01T00:00:00Z`);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  const previous = lastMonth.toISOString().slice(0, 7);

  /* The SALES figures — value, collected, new shops — come from the score's
     own reading, not from the field-activity query beside it. That query
     counts orders by who typed them, at the price with GST, pending and
     declined included, and money still waiting on accounts; the score counts
     accepted orders of the shops credited to him, net of GST, and confirmed
     money only. Two definitions on two screens gave one man two order values
     for one month. The field query still answers what only it can: visits,
     orders taken in the field, days worked. */
  const [record, current, before, evidence, retentionHours, towns, scoreNow, scoreBefore] = await Promise.all([
    salesmanRecord(id),
    performance(`${thisMonth}-01`, endOfMonth(thisMonth)),
    performance(`${previous}-01`, endOfMonth(previous)),
    dayEvidence(id, day),
    getSetting("mbos.attendance.selfieRetentionHours"),
    hometownTree(),
    readingsForPeriod(thisMonth, now, { userIds: [id] }),
    readingsForPeriod(previous, now, { userIds: [id] }),
  ]);

  /* `salesmanRecord` answers null for anybody who does not hold the field app,
   * which covers both "no such person" and "not in the field" — the two are
   * the same answer here, and neither confirms to a URL-guesser that an id
   * belongs to a real account. */
  if (!record) notFound();

  return (
    <SalesmanScreen
      record={record}
      month={thisMonth}
      thisMonth={current.find((r) => r.salesmanId === id) ?? null}
      lastMonth={before.find((r) => r.salesmanId === id) ?? null}
      score={figuresOf(scoreNow[0])}
      scoreLast={figuresOf(scoreBefore[0])}
      day={day}
      longDay={longDay(day)}
      today={now}
      dayEvidence={evidence}
      selfieRetentionHours={retentionHours}
      openDayCheck={asked !== null}
      towns={towns}
    />
  );
}

/** The plain figures the screen needs — a reading carries Maps, which cannot cross to a client. */
function figuresOf(r: PerformanceReading | undefined): ScoreFigures {
  if (!r) {
    return { hasTarget: false, scoreBp: null, rating: null, revenuePaise: 0, revenueTargetPaise: null, collectedPaise: 0, newCustomers: 0 };
  }
  const revenue = r.score.components.find((c) => c.key === "revenue");
  return {
    hasTarget: r.hasTarget,
    scoreBp: r.hasTarget ? r.score.totalBp : null,
    rating: r.hasTarget ? r.rating : null,
    revenuePaise: r.actuals.revenuePaise,
    revenueTargetPaise: r.hasTarget ? revenue?.target || null : null,
    collectedPaise: r.actuals.collectionPaise,
    newCustomers: r.actuals.newCustomers,
  };
}

/** Rendered as a UTC calendar date, which is what an ISO day already is. */
function longDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
