import "server-only";
import { money } from "@/lib/format";
import { addDays, calendarDate, periodRange } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import {
  consoleCounts,
  expenseClaims,
  fieldInvoiceTotals,
  fieldInvoicesPage,
  fieldOrders,
  fieldReceipts,
  fieldSamples,
  leadsList,
  leaveRequests,
  managerScope,
  pendingApprovals,
  performance,
  teamDay,
  type PerformanceRow,
} from "@/lib/services/sales-service";
import { readingsForPeriod, type PerformanceReading } from "@/lib/services/performance-service";

/* ---------------------------------------------------------------------------
 * The figures the console's Ask panel answers from.
 *
 * "Written from your team's figures" is a claim the screen makes in the
 * design, in small capitals, above every answer. This file is what makes that
 * sentence true: the model is handed a compact statement of what the team
 * actually did and is told, in the system prompt, that it may use nothing
 * else. A model asked "how is Mahesh doing" with no figures will answer
 * anyway, fluently and from nothing, and a fluent invented number on a
 * performance screen is worse than any refusal.
 *
 * WHY IT IS ASSEMBLED RATHER THAN QUERIED ON DEMAND. There is no tool-calling
 * loop here and there should not be: the questions a field manager asks are
 * about figures they can already see on this dashboard's own screens, so
 * fetching them all costs one round of queries and removes every path where
 * the model chooses what to look up. Every section below reads the SAME
 * function the corresponding screen reads — `teamDay`, `performance`,
 * `consoleCounts`, `pendingApprovals`, `fieldOrders`, `fieldReceipts`,
 * `fieldInvoicesPage`, `leaveRequests`, `expenseClaims`, `fieldSamples`,
 * `leadsList`, `readingsForPeriod` — so the panel and the screen it is
 * standing in for cannot quote different numbers for one salesman.
 *
 * IT IS SCOPED, because those functions are. `managerScope()` is read once by
 * every one of them, so a regional manager asking about "the team" gets their
 * own region back — nothing here widens what they can see. The one function
 * that is NOT scoped by territory on its own, `readingsForPeriod`, is asked
 * for named users rather than everybody, passing the same `salesmanIds` the
 * scoped queries resolved to.
 *
 * LISTS ARE CAPPED, the same way every screen in this app caps a list — the
 * text says how many more there are rather than pretending the top few are
 * the whole answer, because a capped list that does not say so is a list
 * somebody can be quietly misled by.
 *
 * AND A HEADLINE FIGURE IS COUNTED IN SQL, NEVER SUMMED OVER THE ROWS. This
 * brief is written to be QUOTED — a manager reads "the team is holding
 * ₹4,20,000 in cash" out of the panel and rings somebody about it. Summing a
 * capped read told them what the newest three hundred receipts came to, which
 * is a real number about the wrong set and reads exactly like the right one.
 * So every count and total in a heading below comes from a figure the service
 * counted over the whole book, and the rows printed under it are a sample by
 * construction — `capped(...)` is what says so, and the ranking a sample
 * supports ("who is holding the most") survives being a sample in a way a
 * total never does.
 * ------------------------------------------------------------------------- */

export type TeamBrief = {
  /** What the model is shown. Plain text, because that is what it reads. */
  text: string;
  /** For the screen: the window the answer describes, said in words. */
  period: { from: string; to: string };
  /** Whether there is anything at all to answer from. */
  empty: boolean;
};

const rupees = (paise: number) => money(paise);
const CAP = 6;

/** millilitres, as litres — the unit anybody actually says out loud. */
const litres = (ml: number) => `${Math.round(ml / 1000).toLocaleString("en-IN")} L`;

const pct = (bp: number | null | undefined) => (bp == null ? "not scored" : `${Math.round(bp / 100)}%`);

/** A capped list, with a line saying how many were left out. */
function capped<T>(rows: T[], format: (r: T) => string, noun: string): string[] {
  if (!rows.length) return [];
  const lines = rows.slice(0, CAP).map(format);
  if (rows.length > CAP) {
    lines.push(`- …and ${rows.length - CAP} more ${noun}`);
  }
  return lines;
}

/**
 * One salesman's month, as a line.
 *
 * Adherence is given as walked-of-planned rather than as a percentage the
 * model would have to compute — arithmetic is exactly what a language model
 * should not be asked to do on figures somebody will act on.
 */
function personLine(r: PerformanceRow): string {
  const bits = [
    `${r.visits} visits (${r.verifiedVisits} verified)`,
    `${r.orders} orders worth ${rupees(r.orderValuePaise)}`,
    `${rupees(r.collectedPaise)} collected`,
    `${r.newCustomers} new customers`,
    `${r.walkedStops} of ${r.plannedStops} planned stops walked`,
    `${r.daysWorked} days worked`,
  ];
  return `- ${r.salesmanName}: ${bits.join("; ")}`;
}

/**
 * One salesman's target and score, as a line.
 *
 * The percentages are read straight off `score.components` — the exact
 * numbers the Performance screen shows — never recomputed here, so the panel
 * cannot round or divide its way to a different answer than the screen.
 */
function targetLine(r: PerformanceReading): string {
  if (!r.hasTarget) {
    return `- ${r.userName}: no published target this month, so no score. Sold ${rupees(r.actuals.revenuePaise)} (${litres(r.actuals.millilitres)}) anyway.`;
  }
  const by = (k: string) => r.score.components.find((c) => c.key === k)?.achievementBp ?? null;
  const bits = [
    `score ${(r.score.totalBp / 100).toFixed(1)}/100 (${r.rating})`,
    `revenue ${rupees(r.actuals.revenuePaise)} — ${pct(by("revenue"))} of target`,
    `volume ${litres(r.actuals.millilitres)} — ${pct(by("volume"))} of target`,
    `mix ${pct(r.mix.achievementBp)} of target`,
    `${r.actuals.newCustomers} new customers — ${pct(by("newCustomers"))} of target`,
    `${rupees(r.actuals.collectionPaise)} collected — ${pct(by("collection"))} of target`,
    `activity ${pct(by("activity"))} of target`,
  ];
  const line = `- ${r.userName}: ${bits.join("; ")}`;
  return r.alerts.length ? `${line}\n  ⚠ ${r.alerts.map((a) => a.message).join(" ")}` : line;
}

/**
 * Everything the Ask panel is allowed to know.
 *
 * The month so far and today, because those are the two windows the console
 * itself draws — a manager asking "how are we doing" means the month, and
 * "who is out" means right now. The sections below it are the rest of the
 * dashboard's present state — approvals, cash, orders, leads, bills, leave and
 * expense claims, samples — as of the moment the question is asked.
 */
export async function teamBrief(): Promise<TeamBrief> {
  const day = await today();
  const config = await getConfig();
  // The same window the console's own month figures use, through the same
  // pure function — a brief that measured its month differently to the
  // Performance screen would answer a question the screen contradicts.
  const month = periodRange(day, "month", {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
  const periodKey = month.from.slice(0, 7);

  const scope = await managerScope();

  const [
    rows,
    now,
    counts,
    readings,
    approvals,
    receipts,
    pendingOrders,
    leads,
    invoiceTotals,
    overdueInvoicePage,
    leave,
    expenses,
    samples,
  ] = await Promise.all([
    performance(month.from, month.to),
    teamDay(day),
    consoleCounts(day, addDays(day, 1)),
    // Named users only where the manager is regional — `readingsForPeriod`
    // scores the whole company by default, and this is the one read in this
    // file that does not scope itself.
    readingsForPeriod(periodKey, day, {
      userIds: scope.national ? undefined : (scope.salesmanIds ?? []),
    }),
    pendingApprovals(),
    fieldReceipts(),
    fieldOrders("waiting"),
    leadsList(day),
    /*
     * THE FIGURES FROM AN AGGREGATE, THE LIST FROM A PAGE.
     *
     * This called `fieldInvoices()`, which was capped at 300 rows with no
     * count — so the brief's "N bills open, total ₹X" was the 300 biggest
     * balances described as the book. The real number is 8,682. The counts and
     * the sums come from Postgres now; only the overdue lines it actually
     * prints are fetched, and it caps those itself a few lines down.
     */
    fieldInvoiceTotals(),
    fieldInvoicesPage({ show: "overdue" }, { page: 1, perPage: 200 }),
    leaveRequests(),
    expenseClaims(),
    fieldSamples(),
  ]);

  const waiting = Object.entries(counts)
    .filter(([k, n]) => typeof n === "number" && n > 0 && k !== "alerts")
    .map(([k, n]) => `- ${k}: ${n}`);

  const notCheckedIn = now.people.filter((p) => p.active && !p.checkInAt);

  const lines = [
    `TODAY (${day})`,
    `- ${now.totals.checkedIn} of ${now.totals.outOf} salesmen checked in`,
    `- ${now.totals.visits} visits, ${now.totals.orders} orders worth ${rupees(now.totals.orderValuePaise)}`,
    `- ${rupees(now.totals.collectedPaise)} collected (reported by the field, not yet confirmed by accounts)`,
    `- ${now.totals.walkedStops} of ${now.totals.plannedStops} planned stops walked`,
    `- not checked in: ${notCheckedIn.length ? notCheckedIn.map((p) => p.name).join(", ") : "nobody — the whole team is in"}`,
    "",
    `THIS MONTH SO FAR (${month.from} to ${month.to}), per salesman:`,
    ...(rows.length ? rows.map(personLine) : ["- nobody has any activity recorded"]),
  ];

  if (waiting.length) {
    lines.push("", "WAITING ON THE MANAGER RIGHT NOW (counts):", ...waiting);
  }

  lines.push(
    "",
    `TARGETS AND SCORE FOR ${monthLabel(periodKey)}, out of 100, against what was actually asked of each person:`,
    ...(readings.length
      ? readings.map(targetLine)
      : ["- nobody has a published target for this month"]),
  );

  /* `leave.waiting` is the count over every request; these are the examples to
     print under it. The list is ordered pending-first, so the ones a manager is
     being asked to act on are never the part the cap drops. */
  const pendingLeave = leave.rows.filter((l) => l.approvalState === "pending");
  const pendingExpenses = expenses.rows.filter((e) => e.approvalState === "pending");

  lines.push(
    "",
    `APPROVALS WAITING ON YOU RIGHT NOW (${approvals.length}, oldest first):`,
    ...(approvals.length
      ? capped(
          approvals,
          (a) =>
            `- ${a.type} from ${a.requestedByName}: ${a.summary}${
              a.amountPaise != null ? ` (${rupees(a.amountPaise)})` : ""
            }${a.customerName ? ` — ${a.customerName}` : ""}, waiting since ${calendarDate(a.requestedAt)}`,
          "waiting",
        )
      : ["- nothing waiting"]),
  );

  /*
   * THE CASH TOTAL COMES FROM THE SHARED LIST, NOT FROM A FILTER OVER THE LOG.
   *
   * This read its own `mode === "Cash" && !depositedAt` filter over `rows`,
   * which is the newest few hundred receipts — so on a book of any size the
   * money a manager was told his team was carrying was whatever those rows
   * happened to contain. `receipts.cash` is every unbanked note in scope,
   * uncapped, and it is the SAME list the Payments screen totals, so the panel
   * and the screen can no longer quote one manager two different figures for
   * one team's cash. That is the reason to take it, rather than the saving.
   *
   * IT IS A SMALL BEHAVIOUR CHANGE AND IT IS DELIBERATE. The old filter also
   * excluded `reversed` receipts and the shared definition does not: a note
   * that was physically handed over is a note the salesman is holding, whatever
   * became of the receipt afterwards, and a reversal is a fact about the ledger
   * rather than about what is in somebody's bag. The figure can therefore read
   * a little higher than it used to on a team with reversals in it. Rejected
   * receipts are excluded at source in both readings.
   */
  const cashHeld = receipts.cash;
  const cashByPerson = new Map<string, number>();
  for (const r of cashHeld) {
    const name = r.salesmanName ?? "Unassigned";
    cashByPerson.set(name, (cashByPerson.get(name) ?? 0) + r.amountPaise);
  }
  // Safe to sum, and only because the list above is the whole of it.
  const cashTotal = cashHeld.reduce((sum, r) => sum + r.amountPaise, 0);

  lines.push(
    "",
    `CASH THE TEAM IS PHYSICALLY HOLDING, not yet deposited (total ${rupees(cashTotal)}):`,
    ...(cashByPerson.size
      ? [...cashByPerson.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, paise]) => `- ${name}: ${rupees(paise)}`)
      : ["- none"]),
  );

  lines.push(
    "",
    /* The count is every pending order in scope; the lines under it are the
       page of them this read returned, sorted by how long each has waited. */
    `ORDERS WAITING ON ACCOUNTS' APPROVAL (${pendingOrders.total}, longest-waiting first):`,
    ...(pendingOrders.rows.length
      ? capped(
          [...pendingOrders.rows].sort((a, b) => b.waitingHours - a.waitingHours),
          (o) =>
            `- ${o.customerName} via ${o.salesmanName ?? "unassigned"}: ${rupees(o.totalAmountPaise)}, waiting ${o.waitingHours}h${o.creditBlocked ? " — CREDIT BLOCKED" : ""}`,
          "orders",
        )
      : ["- none"]),
  );

  const stageOf = new Map<string, number>();
  let quiet = 0;
  for (const l of leads) {
    stageOf.set(l.stage, (stageOf.get(l.stage) ?? 0) + 1);
    if (l.quietDays >= 14) quiet++;
  }
  lines.push(
    "",
    `LEADS BEING WORKED (${leads.length} open, ${quiet} untouched for 14+ days):`,
    ...(stageOf.size
      ? [...stageOf.entries()].map(([stage, n]) => `- ${stage}: ${n}`)
      : ["- none"]),
  );

  /* Counted and summed over the whole book by `fieldInvoiceTotals`, not over
     whatever rows happened to be fetched. */
  const outstandingTotal = invoiceTotals.owedPaise;
  const overdueTotal = invoiceTotals.overdueOwedPaise;
  const overdueInvoices = overdueInvoicePage.rows;

  lines.push(
    "",
    `WHAT THE TEAM'S BOOK OWES (${invoiceTotals.open} bills open, total ${rupees(outstandingTotal)}; ${invoiceTotals.overdue} overdue, total ${rupees(overdueTotal)}):`,
    ...capped(
      [...overdueInvoices].sort((a, b) => b.overdueDays - a.overdueDays),
      (b) => `- ${b.customerName} via ${b.salesmanName ?? "unassigned"}: ${rupees(b.openPaise)}, ${b.overdueDays} days overdue`,
      "overdue bills",
    ),
  );

  lines.push(
    "",
    `LEAVE REQUESTS WAITING (${leave.waiting}):`,
    ...(pendingLeave.length
      ? capped(
          pendingLeave,
          (l) =>
            `- ${l.salesmanName}: ${l.leaveType}, ${l.fromDate} to ${l.toDate} (${l.days} day${l.days === 1 ? "" : "s"})${l.clashesWith ? ` — clashes with ${l.clashesWith}` : ""}`,
          "requests",
        )
      : ["- none"]),
  );

  lines.push(
    "",
    `EXPENSE CLAIMS WAITING (${expenses.waiting}):`,
    ...(pendingExpenses.length
      ? capped(
          pendingExpenses,
          (e) => `- ${e.salesmanName}: ${e.category}, ${rupees(e.amountPaise)}, ${e.expenseDate}`,
          "claims",
        )
      : ["- none"]),
  );

  /* `samples.late` is counted over every sample in scope; these are the ones to
     name. The list is ordered pending-first and then most-overdue-first, so the
     late ones lead it and the cap can only ever drop the least late. */
  const lateSamples = samples.rows.filter((s) => s.lateDays > 0);
  if (samples.late) {
    lines.push(
      "",
      `SAMPLES WITH FEEDBACK OVERDUE (${samples.late}):`,
      ...capped(
        lateSamples,
        (s) => `- ${s.customerName} via ${s.salesmanName}: ${s.productName ?? "product"}, ${s.lateDays} days late`,
        "samples",
      ),
    );
  }

  const dataless =
    rows.length === 0 &&
    now.totals.visits === 0 &&
    now.totals.orders === 0 &&
    readings.length === 0 &&
    approvals.length === 0 &&
    cashHeld.length === 0 &&
    // Counts, not row lengths: a page that came back empty because everything
    // in it was filtered out is not the same as a book with nothing in it, and
    // the panel would otherwise say there is nothing to answer from while the
    // headings above it were quoting real figures.
    pendingOrders.total === 0 &&
    leads.length === 0 &&
    invoiceTotals.open === 0 &&
    leave.waiting === 0 &&
    expenses.waiting === 0 &&
    samples.late === 0;

  return {
    text: lines.join("\n"),
    period: { from: month.from, to: month.to },
    // Nothing anywhere on the dashboard. The panel says so rather than asking
    // a model to be interesting about an empty database.
    empty: dataless,
  };
}

function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, 15)),
  );
}

/**
 * The rules the answer is written under.
 *
 * Two of these are the whole point. **Use only the figures given** is what
 * makes "written from your team's figures" a true sentence rather than a
 * decoration. **Say when the figures do not answer it** is what stops the
 * model from bridging a gap with something plausible — a manager who asks
 * about last quarter must be told that this is the month, not given a number
 * shaped like an answer.
 */
export const ASK_SYSTEM = `You answer a field sales manager's questions about their own team, using a written digest of their MBOS Sales Dashboard — today's activity, this month's per-salesman figures, targets and scores, approvals waiting on them, cash the team is holding, orders waiting on accounts, the leads pipeline, what the book is owed, and pending leave, expense and sample follow-ups.

You are given a block of FIGURES. Those figures are the only facts you have.

Rules:
- Use ONLY the figures given. Never estimate, extrapolate, or supply a number that is not there.
- If the figures do not answer the question — because it is about something this digest does not cover, or a period outside "today" and "this month" — say so plainly and name what IS available. Do not bridge the gap.
- Do no arithmetic beyond comparing and ranking the numbers as written. Never compute percentages, averages or totals that are not given.
- Money is already formatted. Quote it exactly as written; never re-format or convert it.
- Collections are what the field REPORTED, not money accounts have confirmed. If you mention a collected figure, say so.
- A capped list says "…and N more" when it is not the whole list. Say so if you are reading from one, rather than implying the list you were given is everybody.
- Be brief: two or three sentences, or a short list where the question asks for a ranking.
- Name people as the figures name them.
- Plain English. No preamble, no "based on the figures provided", no offers to help further.`;
