import { all } from '../db';

/**
 * His own month, as the office scored it.
 *
 * READ ONLY, and deliberately so. Nothing on this handset writes a target or a
 * score — the table has no insert path outside the sync applier, which is the
 * same rule the office enforces on its own screens: a salesman who can edit
 * what he is measured against is not being measured.
 *
 * The figures are the office's CACHE, rebuilt hourly, so they are minutes to
 * an hour old rather than live. `computedAt` comes down on the row for exactly
 * that reason and the screen prints it — the same courtesy the credit limit
 * and the outstanding balance already get here.
 */

export type MixCategory = {
  name: string;
  targetBp: number;
  minimumBp: number;
  actualBp: number;
  actualMl: number;
  status: 'below-minimum' | 'below-target' | 'on-target' | 'stretch';
};

export type PerformanceMonth = {
  period: string;
  revenueTargetPaise: number | null;
  revenueActualPaise: number;
  revenueAchievementBp: number | null;
  volumeTargetMl: number | null;
  volumeActualMl: number;
  volumeAchievementBp: number | null;
  mixAchievementBp: number | null;
  newCustomerTarget: number | null;
  newCustomerActual: number;
  collectionTargetPaise: number | null;
  collectionActualPaise: number;
  activityTarget: number | null;
  activityActual: number;
  totalScoreBp: number | null;
  rating: string | null;
  unmatchedRevenuePaise: number;
  categories: MixCategory[];
  computedAt: string | null;
  /** False where the office has published no target — there is nothing to score. */
  hasTarget: boolean;
};

type Row = Omit<PerformanceMonth, 'categories' | 'hasTarget'> & {
  categories: string | null;
  untargeted: string | null;
};

/**
 * The months the handset holds, newest first.
 *
 * Two at most, because that is what the server sends: on the 2nd of a month
 * the month somebody is actually being judged on is still the previous one,
 * and a screen showing two days of a fresh month reads as broken.
 */
export async function listPerformance(): Promise<PerformanceMonth[]> {
  const rows = await all<Row>(
    `SELECT period, revenueTargetPaise, revenueActualPaise, revenueAchievementBp,
            volumeTargetMl, volumeActualMl, volumeAchievementBp, mixAchievementBp,
            newCustomerTarget, newCustomerActual,
            collectionTargetPaise, collectionActualPaise,
            activityTarget, activityActual,
            totalScoreBp, rating, untargeted, unmatchedRevenuePaise,
            categories, computedAt
       FROM performance
      ORDER BY period DESC`,
  );

  return rows.map((r) => ({
    ...r,
    revenueActualPaise: r.revenueActualPaise ?? 0,
    volumeActualMl: r.volumeActualMl ?? 0,
    newCustomerActual: r.newCustomerActual ?? 0,
    collectionActualPaise: r.collectionActualPaise ?? 0,
    activityActual: r.activityActual ?? 0,
    unmatchedRevenuePaise: r.unmatchedRevenuePaise ?? 0,
    categories: parseCategories(r.categories),
    /*
     * A target exists if ANY of the five was asked for.
     *
     * Not "a row exists": the office writes a row for anybody who sold
     * something, target or not, so the row's presence says he has been
     * scored — it does not say anything was asked of him.
     */
    hasTarget:
      r.revenueTargetPaise !== null ||
      r.volumeTargetMl !== null ||
      r.newCustomerTarget !== null ||
      r.collectionTargetPaise !== null ||
      r.activityTarget !== null,
  }));
}

/** JSON arriving over a wire is not to be trusted into a render. */
function parseCategories(raw: string | null): MixCategory[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MixCategory[]) : [];
  } catch {
    return [];
  }
}

/** Millilitres are what is stored; litres are what anybody says out loud. */
export function litres(ml: number): string {
  if (!ml) return '0 L';
  return `${Math.round(ml / 1000).toLocaleString('en-IN')} L`;
}

/**
 * What is short, worst first, in the words the work is done in.
 *
 * The same job `lib/engines/performance.ts` does on the server, and
 * deliberately NOT the same code: the handset holds only this one person's
 * finished figures, not the engine's inputs, so there is nothing here to
 * re-derive. What it must not do is re-derive the SCORE — that is the office's
 * answer, and a second implementation of it on a phone is how the two come to
 * disagree about somebody's appraisal.
 */
export function shortfalls(month: PerformanceMonth): string[] {
  const lines: string[] = [];
  const rupees = (paise: number) =>
    `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

  if (month.revenueTargetPaise && month.revenueActualPaise < month.revenueTargetPaise) {
    lines.push(
      `${rupees(month.revenueTargetPaise - month.revenueActualPaise)} short of your revenue target.`,
    );
  }
  if (month.volumeTargetMl && month.volumeActualMl < month.volumeTargetMl) {
    lines.push(
      `${litres(month.volumeTargetMl - month.volumeActualMl)} short of your volume target.`,
    );
  }
  if (month.newCustomerTarget && month.newCustomerActual < month.newCustomerTarget) {
    const gap = month.newCustomerTarget - month.newCustomerActual;
    lines.push(`${gap} more new ${gap === 1 ? 'customer' : 'customers'} this month.`);
  }
  if (
    month.collectionTargetPaise &&
    month.collectionActualPaise < month.collectionTargetPaise
  ) {
    lines.push(
      `${rupees(month.collectionTargetPaise - month.collectionActualPaise)} still to collect.`,
    );
  }
  for (const c of month.categories) {
    if (c.status !== 'below-minimum') continue;
    lines.push(
      `${c.name} is at ${(c.actualBp / 100).toFixed(1)}% — below the ${(c.minimumBp / 100).toFixed(0)}% minimum.`,
    );
  }
  return lines;
}

/**
 * Revenue at target while volume is not.
 *
 * The one thing this screen exists to make visible on a phone: a price
 * revision moves what a month is worth and cannot move how much was sold, so
 * this is the month that looks good and is not.
 */
export function priceNotVolume(month: PerformanceMonth): boolean {
  return (
    month.revenueAchievementBp !== null &&
    month.volumeAchievementBp !== null &&
    month.revenueAchievementBp >= 10_000 &&
    month.volumeAchievementBp < 10_000
  );
}
