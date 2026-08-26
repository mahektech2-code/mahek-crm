import "server-only";
import type { BusinessDate, DateRange } from "@/lib/business-date";
import {
  ownerDashboard,
  type OwnerDashboard,
} from "@/lib/services/owner-dashboard-service";
import {
  readingsForPeriod,
  type PerformanceReading,
} from "@/lib/services/performance-service";
import {
  accountsHome,
  type AccountsHome,
} from "@/lib/services/accounts-home-service";
import {
  employeeMaster,
  type EmployeeMaster,
} from "@/lib/services/employee-service";
import { rankPerformance, type Ranked } from "@/lib/engines/performance";

/* ---------------------------------------------------------------------------
 * The Founder Dashboard, read off four apps that already compute everything
 * it shows.
 *
 * This file decides NOTHING — every number is `ownerDashboard()`,
 * `readingsForPeriod()`, `accountsHome()` or `employeeMaster()`, unchanged.
 * The only new logic anywhere in this app is `rankPerformance()`, a pure sort
 * in `lib/engines/performance.ts`. A reporting layer that re-derives what its
 * source apps already answer is how a rollup comes to disagree with the
 * screens it is rolling up.
 * ------------------------------------------------------------------------- */

export type RankedReading = Ranked<
  PerformanceReading & { totalBp: number; revenuePaise: number }
>;

function rank(readings: PerformanceReading[]): RankedReading[] {
  return rankPerformance(
    readings.map((r) => ({
      ...r,
      totalBp: r.score.totalBp,
      revenuePaise: r.actuals.revenuePaise,
    })),
  );
}

export type FounderOverview = {
  crm: OwnerDashboard;
  team: {
    ranked: RankedReading[];
    scored: number;
    total: number;
  };
  money: AccountsHome;
  people: EmployeeMaster["summary"];
};

/**
 * The whole overview, in one call — four independent reads in parallel,
 * because nothing here depends on anything else's answer.
 */
export async function founderOverview(
  range: DateRange,
  comparedWith: DateRange,
  lastYearRange: DateRange,
  today: BusinessDate,
  performancePeriod: string,
): Promise<FounderOverview> {
  const [crm, readings, money, people] = await Promise.all([
    ownerDashboard(range, comparedWith, lastYearRange, today, {}),
    readingsForPeriod(performancePeriod, today, {}),
    accountsHome(),
    employeeMaster(),
  ]);

  return {
    crm,
    team: {
      ranked: rank(readings),
      scored: readings.filter((r) => r.hasTarget).length,
      total: readings.length,
    },
    money,
    people: people.summary,
  };
}

/**
 * Everybody scored, ranked — telecallers and the field team together.
 *
 * No `userIds` restriction: `readingsForPeriod` already answers for whoever
 * holds a published target or sold something, company-wide, which is exactly
 * what a founder needs and what `/sales/performance` already shows a manager
 * for their own team.
 */
export async function founderTeamPerformance(
  period: string,
  today: BusinessDate,
): Promise<RankedReading[]> {
  const readings = await readingsForPeriod(period, today, {});
  return rank(readings);
}

export async function founderMoney(): Promise<AccountsHome> {
  return accountsHome();
}

export async function founderPeople(): Promise<EmployeeMaster> {
  return employeeMaster();
}
