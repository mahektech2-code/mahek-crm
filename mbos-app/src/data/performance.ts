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
  /**
   * The components nobody set a target for, which were DROPPED from the score.
   *
   * The office does not mark an unset component nought — that would dock
   * somebody for a question never put to them — nor a hundred, which would pay
   * them for it. It leaves the component out and restates the remaining weights
   * out of a hundred, which is what keeps "out of 100, against what was
   * actually asked of you" a true sentence. That makes this list part of the
   * score rather than a footnote to it: an 84 across six components and an 84
   * across three are different months.
   *
   * It was selected off the row and thrown away before it reached the screen,
   * so the phone drew the number and the office's own screen drew the caveat.
   */
  untargeted: string[];
  /** False where the office has published no target — there is nothing to score. */
  hasTarget: boolean;
};

type Row = Omit<PerformanceMonth, 'categories' | 'untargeted' | 'hasTarget'> & {
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
    untargeted: parseKeys(r.untargeted),
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

/** The same guard, for the list of dropped components. */
function parseKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * What was left out of the score, in the same words the office's own screen
 * uses.
 *
 * Deliberately the CRM's labels rather than this screen's tile captions: a
 * salesman and his manager reading the same month must not be given two
 * vocabularies for the six things it is built from. A key nobody recognises is
 * printed as it arrived rather than dropped — a shorter list would understate
 * how much of the score was left out, which is the one direction this sentence
 * must not be wrong in.
 */
const COMPONENT_LABELS: Record<string, string> = {
  revenue: 'revenue',
  volume: 'volume',
  mix: 'product mix',
  newCustomers: 'new customers',
  collection: 'collection',
  activity: 'visits and calls',
};

export function untargetedLine(month: PerformanceMonth): string | null {
  const names = month.untargeted.map((k) => COMPONENT_LABELS[k] ?? k);
  if (!names.length) return null;
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return (
    `Nothing was asked of you on ${listed}, so ` +
    `${names.length === 1 ? 'it is' : 'they are'} left out and the weight is ` +
    'shared among the rest. The score is still out of 100.'
  );
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
