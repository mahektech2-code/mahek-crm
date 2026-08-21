import "server-only";
import { money } from "@/lib/format";
import { addDays, periodRange } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import {
  consoleCounts,
  performance,
  teamDay,
  type PerformanceRow,
} from "@/lib/services/sales-service";

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
 * about a dozen figures they can already see on four screens, so fetching them
 * all costs one round of queries and removes every path where the model
 * chooses what to look up. It reads the same functions the screens read —
 * `teamDay`, `performance`, `consoleCounts` — so the panel and the Performance
 * screen cannot quote different numbers for one salesman.
 *
 * IT IS SCOPED, because those functions are. A manager asking about "the team"
 * gets their own team; nothing here widens what they can see.
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
 * Everything the Ask panel is allowed to know.
 *
 * The month so far and today, because those are the two windows the console
 * itself draws — a manager asking "how are we doing" means the month, and
 * "who is out" means right now.
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

  const [rows, now, counts] = await Promise.all([
    performance(month.from, month.to),
    teamDay(day),
    consoleCounts(day, addDays(day, 1)),
  ]);

  const waiting = Object.entries(counts)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([k, n]) => `${k.replace("/sales/", "")}: ${n}`);

  const lines = [
    `TODAY (${day})`,
    `- ${now.totals.checkedIn} of ${now.totals.outOf} salesmen checked in`,
    `- ${now.totals.visits} visits, ${now.totals.orders} orders worth ${rupees(now.totals.orderValuePaise)}`,
    `- ${rupees(now.totals.collectedPaise)} collected (reported by the field, not yet confirmed by accounts)`,
    `- ${now.totals.walkedStops} of ${now.totals.plannedStops} planned stops walked`,
    "",
    `THIS MONTH SO FAR (${month.from} to ${month.to}), per salesman:`,
    ...(rows.length ? rows.map(personLine) : ["- nobody has any activity recorded"]),
  ];

  if (waiting.length) {
    lines.push("", "WAITING ON THE MANAGER RIGHT NOW:", ...waiting.map((w) => `- ${w}`));
  }

  return {
    text: lines.join("\n"),
    period: { from: month.from, to: month.to },
    // Nothing today and nothing all month. The panel says so rather than
    // asking a model to be interesting about an empty table.
    empty: rows.length === 0 && now.totals.visits === 0 && now.totals.orders === 0,
  };
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
export const ASK_SYSTEM = `You answer a field sales manager's questions about their own team.

You are given a block of FIGURES. Those figures are the only facts you have.

Rules:
- Use ONLY the figures given. Never estimate, extrapolate, or supply a number that is not there.
- If the figures do not answer the question, say so plainly and name what IS available. Do not bridge the gap.
- Do no arithmetic beyond comparing and ranking the numbers as written. Never compute percentages, averages or totals that are not given.
- Money is already formatted. Quote it exactly as written; never re-format or convert it.
- Collections are what the field REPORTED, not money accounts have confirmed. If you mention a collected figure, say so.
- Be brief: two or three sentences, or a short list where the question asks for a ranking.
- Name people as the figures name them.
- Plain English. No preamble, no "based on the figures provided", no offers to help further.`;
