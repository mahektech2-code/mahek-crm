import { all } from '../db';
import { inrFromPaise } from '../lib/format';
import { performanceForRange } from '../sync/api';
import { endOfMonthIso } from '../engines/periods';

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
  /** `YYYY-MM` for a month the sync carried; null for a range read live. */
  period: string | null;
  /** The two ends of what these figures cover, `YYYY-MM-DD`. */
  from: string;
  to: string;
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
  /**
   * WHAT THAT MONEY WAS A SHARE OF — the old debt on his book when the month
   * opened. NULL means the office did not send one, which is not zero: zero is
   * the claim that nothing was overdue, and a row pulled by an older build
   * would be making it.
   */
  collectionBasePaise: number | null;
  /**
   * THE COLLECTION TARGET AS THE SHARE THE OFFICE SET — 5000 is "collect half
   * of what was overdue". The rupee figure above is that share applied to his
   * own overdue book; this is what was actually asked, and the screen leads
   * with it. Null where nothing was asked or there was nothing overdue.
   */
  collectionTargetBp: number | null;
  activityTarget: number | null;
  activityActual: number;
  /** And how many tasks were ASKED of him. Same rule about null. */
  activityAssigned: number | null;
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
  /**
   * For a range: how many calendar months it touches, how many of them carried
   * a published target, and whether a month only partly inside it contributed
   * part of its target. A month off the sync is one of one, whole.
   */
  monthsInRange: number;
  monthsTargeted: number;
  prorated: boolean;
  /** Where the figures came from — the synced cache, or asked for just now. */
  source: 'synced' | 'live';
};

/** A month the sync carried, which always knows which month it is. */
export type SyncedMonth = PerformanceMonth & { period: string };

type Row = Omit<
  PerformanceMonth,
  | 'categories'
  | 'untargeted'
  | 'hasTarget'
  | 'from'
  | 'to'
  | 'collectionTargetBp'
  | 'monthsInRange'
  | 'monthsTargeted'
  | 'prorated'
  | 'source'
  | 'period'
> & {
  period: string;
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
export async function listPerformance(): Promise<SyncedMonth[]> {
  const rows = await all<Row>(
    `SELECT period, revenueTargetPaise, revenueActualPaise, revenueAchievementBp,
            volumeTargetMl, volumeActualMl, volumeAchievementBp, mixAchievementBp,
            newCustomerTarget, newCustomerActual,
            collectionTargetPaise, collectionActualPaise, collectionBasePaise,
            activityTarget, activityActual, activityAssigned,
            totalScoreBp, rating, untargeted, unmatchedRevenuePaise,
            categories, computedAt
       FROM performance
      ORDER BY period DESC`,
  );

  return rows.map((r) => ({
    ...r,
    from: `${r.period}-01`,
    to: endOfMonthIso(r.period),
    collectionTargetBp: impliedShareBp(r.collectionTargetPaise, r.collectionBasePaise),
    monthsInRange: 1,
    monthsTargeted: 1,
    prorated: false,
    source: 'synced' as const,
    revenueActualPaise: r.revenueActualPaise ?? 0,
    volumeActualMl: r.volumeActualMl ?? 0,
    newCustomerActual: r.newCustomerActual ?? 0,
    collectionActualPaise: r.collectionActualPaise ?? 0,
    activityActual: r.activityActual ?? 0,
    unmatchedRevenuePaise: r.unmatchedRevenuePaise ?? 0,
    categories: parseCategories(r.categories),
    untargeted: parseKeys(r.untargeted),
    /*
     * A target exists if ANY of the six was asked for.
     *
     * Not "a row exists": the office writes a row for anybody who sold
     * something, target or not, so the row's presence says he has been
     * scored — it does not say anything was asked of him.
     *
     * And not "a column is not null" either, which is what this read: the
     * office stores an unasked component as ZERO, never null, so every row
     * passed and a man nobody had set a target for was shown a score of 0
     * out of 100. A figure above zero, or a mix that was scored, is a target.
     */
    hasTarget:
      Boolean(r.revenueTargetPaise) ||
      Boolean(r.volumeTargetMl) ||
      Boolean(r.newCustomerTarget) ||
      Boolean(r.collectionTargetPaise) ||
      Boolean(r.activityTarget) ||
      r.mixAchievementBp !== null,
  }));
}

/**
 * The share the office set, read back off the rupee figure it implied.
 *
 * The cached row stores the collection target in rupees — the share applied to
 * his overdue book — and not the share itself. Dividing one by the other gives
 * the share back exactly, because the rupee figure was rounded from it.
 */
function impliedShareBp(targetPaise: number | null, basePaise: number | null): number | null {
  if (!targetPaise || !basePaise || basePaise <= 0) return null;
  return Math.round((targetPaise * 10_000) / basePaise);
}

/**
 * Any range, read live from the office.
 *
 * The same figures the sync carries for a month, computed over the days asked
 * for — so the screen draws both with one set of code. It needs signal, and
 * says so through `error` rather than drawing an empty month.
 */
export async function fetchPerformance(
  from: string,
  to: string,
): Promise<{ ok: true; month: PerformanceMonth } | { ok: false; error: string }> {
  const out = await performanceForRange(from, to);
  if (!out.ok) return out;
  const r = out.reading as Partial<Record<string, unknown>> | null;
  if (!r || typeof r !== 'object') return { ok: false, error: 'MahekOne sent nothing back.' };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const orNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    ok: true,
    month: {
      period: null,
      from: typeof r.from === 'string' ? r.from : from,
      to: typeof r.to === 'string' ? r.to : to,
      revenueTargetPaise: orNull(r.revenueTargetPaise),
      revenueActualPaise: n(r.revenueActualPaise),
      revenueAchievementBp: orNull(r.revenueAchievementBp),
      volumeTargetMl: orNull(r.volumeTargetMl),
      volumeActualMl: n(r.volumeActualMl),
      volumeAchievementBp: orNull(r.volumeAchievementBp),
      mixAchievementBp: orNull(r.mixAchievementBp),
      newCustomerTarget: orNull(r.newCustomerTarget),
      newCustomerActual: n(r.newCustomerActual),
      collectionTargetPaise: orNull(r.collectionTargetPaise),
      collectionActualPaise: n(r.collectionActualPaise),
      collectionBasePaise: orNull(r.collectionBasePaise),
      collectionTargetBp: orNull(r.collectionTargetBp),
      activityTarget: orNull(r.activityTarget),
      activityActual: n(r.activityActual),
      activityAssigned: orNull(r.activityAssigned),
      totalScoreBp: orNull(r.totalScoreBp),
      rating: typeof r.rating === 'string' ? r.rating : null,
      unmatchedRevenuePaise: n(r.unmatchedRevenuePaise),
      categories: Array.isArray(r.categories) ? (r.categories as MixCategory[]) : [],
      computedAt: typeof r.computedAt === 'string' ? r.computedAt : null,
      untargeted: Array.isArray(r.untargeted)
        ? r.untargeted.filter((k): k is string => typeof k === 'string')
        : [],
      hasTarget: r.hasTarget === true,
      monthsInRange: n(r.monthsInRange) || 1,
      monthsTargeted: n(r.monthsTargeted),
      prorated: r.prorated === true,
      source: 'live',
    },
  };
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
    `You have no target for ${listed}. ` +
    `So ${names.length === 1 ? 'it is' : 'they are'} left out, and the other parts count more. ` +
    'The score is still out of 100.'
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
  if (month.revenueTargetPaise && month.revenueActualPaise < month.revenueTargetPaise) {
    lines.push(
      `${inrFromPaise(month.revenueTargetPaise - month.revenueActualPaise)} short of your revenue target.`,
    );
  }
  if (month.volumeTargetMl && month.volumeActualMl < month.volumeTargetMl) {
    lines.push(
      `${litres(month.volumeTargetMl - month.volumeActualMl)} short of your volume target.`,
    );
  }
  if (month.newCustomerTarget && month.newCustomerActual < month.newCustomerTarget) {
    const gap = month.newCustomerTarget - month.newCustomerActual;
    lines.push(`${gap} more new ${gap === 1 ? 'customer' : 'customers'} to reach your target.`);
  }
  if (
    month.collectionTargetPaise &&
    month.collectionActualPaise < month.collectionTargetPaise
  ) {
    /* Said as the share first, because a share is what was asked. The rupees
       follow, because rupees are what he goes and collects. */
    const at = collectionShareBp(month);
    lines.push(
      (at !== null && month.collectionTargetBp
        ? `Collection is at ${pct(at)} of the overdue book, against ${pct(month.collectionTargetBp)} — `
        : '') +
        `${inrFromPaise(month.collectionTargetPaise - month.collectionActualPaise)} still to collect.`,
    );
  }
  for (const c of month.categories) {
    if (c.status === 'below-minimum') {
      lines.push(
        `${c.name} is at ${(c.actualBp / 100).toFixed(1)}%. The minimum is ${(c.minimumBp / 100).toFixed(0)}%.`,
      );
    } else if (c.status === 'below-target') {
      /* Above the floor and still short of what was asked. Left out, the Home
         card said "You have reached every target set for you" to somebody
         whose mix was under target — praise on the one line he reads. */
      lines.push(
        `${c.name} is at ${(c.actualBp / 100).toFixed(1)}%. The target is ${(c.targetBp / 100).toFixed(0)}%.`,
      );
    }
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

/**
 * How much of the overdue book he has collected, as a share — the figure the
 * collection target is written in.
 *
 * Null where there was no overdue book to collect, which is NOT 0%: nothing
 * owed is nothing to fail at, and the office drops it from the score for
 * exactly that reason.
 */
export function collectionShareBp(month: PerformanceMonth): number | null {
  const base = month.collectionBasePaise;
  if (base == null || base <= 0) return null;
  return Math.round((month.collectionActualPaise / base) * 10_000);
}

function pct(bp: number): string {
  return `${(bp / 100).toFixed(0)}%`;
}
