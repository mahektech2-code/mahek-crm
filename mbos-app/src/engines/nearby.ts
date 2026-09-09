import { haversineMetres, type Coords } from './geo';
import { reorderState } from './leads';

/**
 * What is worth walking to from where you are standing.
 *
 * Two things this is, and one thing it is not.
 *
 * It IS pure and offline. Every shop's coordinate, cycle and outstanding is
 * already on the handset, so this needs no connection — which matters because
 * the moment somebody asks "who else is near me" is the moment they are in a
 * market lane with one bar.
 *
 * It IS ordered by what is worth doing, not by what is closest. The brief says
 * so in as many words: "the nearest customer should not automatically be the
 * highest priority." Distance is a COST, and the thing it is weighed against is
 * whether there is anything to say when you get there.
 *
 * It is NOT a second copy of the Call Log's ranking. That engine weighs a
 * promise against a debt against a stock check to order four hundred names for
 * a telecaller working down a list; this answers "of the eleven shops within
 * three kilometres, which one now". Two different questions, and re-deriving
 * the first here would be a scoring system drifting from a scoring system —
 * with the drift invisible until two screens disagree about one shop.
 */

export type NearbyInput = {
  id: string;
  name: string;
  coords: Coords | null;
  /** Paise. What they owe us, which is a reason to call in person. */
  outstandingPaise: number;
  lastOrderDate: string | null;
  /** Their own measured rhythm, not a company default. */
  cycleDays: number | null;
  lastVisitDate: string | null;
  /** Null on a real customer; a stage means this is still a lead. */
  leadStage: string | null;
  /** A task already waiting on this shop — the strongest reason of all. */
  hasOpenTask: boolean;
};

export type NearbyResult<T extends NearbyInput> = {
  shop: T;
  metres: number;
  /** Why it is worth the walk, in the order the reasons were found. */
  reasons: string[];
  score: number;
};

export type NearbyOptions = {
  radiusMetres: number;
  today: string;
  /**
   * How much a kilometre costs, in the same units the reasons are worth.
   *
   * This is the whole shape of the trade-off and it is configuration rather
   * than a constant: a kilometre on a two-wheeler through Itwari and a
   * kilometre on a district tour are not the same kilometre.
   */
  perKilometreCost?: number;
};

/* What each reason is worth. Ordered the way the Call Log orders its tiers:
   a thing somebody promised beats a thing the calendar suggests. */
const WORTH = {
  openTask: 100,
  overdueReorder: 70,
  owesMoney: 60,
  dueReorder: 40,
  openLead: 30,
  notSeenLately: 10,
} as const;

/** Rupees owed above which the debt is worth a detour on its own. */
const DEBT_FLOOR_PAISE = 100_00;

/**
 * The shops worth stopping at, best first.
 *
 * A shop with NO reason scores nothing and is dropped: "nearby" is not a list
 * of everything within three kilometres, it is a list of what to do. Somebody
 * who wants the full book has the customer list, which is a different screen
 * answering a different question.
 *
 * A shop with no coordinate is dropped here — unlike the route engine, which
 * appends and flags one. The difference is what the answer is FOR: a day's
 * route must not silently lose a stop, but "what is near me" cannot honestly
 * include a shop whose position nobody knows.
 */
export function nearby<T extends NearbyInput>(
  from: Coords,
  shops: T[],
  options: NearbyOptions,
): NearbyResult<T>[] {
  const perKm = options.perKilometreCost ?? 12;
  const out: NearbyResult<T>[] = [];

  for (const shop of shops) {
    if (!shop.coords) continue;
    const metres = haversineMetres(from, shop.coords);
    if (metres > options.radiusMetres) continue;

    const reasons: string[] = [];
    let worth = 0;

    if (shop.hasOpenTask) {
      reasons.push('Something is waiting on your list');
      worth += WORTH.openTask;
    }

    const reorder = reorderState(shop.lastOrderDate, shop.cycleDays, options.today);
    if (reorder === 'overdue') {
      reasons.push('Overdue to reorder');
      worth += WORTH.overdueReorder;
    } else if (reorder === 'due') {
      reasons.push('Due to reorder');
      worth += WORTH.dueReorder;
    }

    if (shop.outstandingPaise >= DEBT_FLOOR_PAISE) {
      reasons.push('Money outstanding');
      worth += WORTH.owesMoney;
    }

    /* A lead still being worked is worth a knock; one that is won, lost or on
       hold is not — those are settled, and turning up would be a wasted stop. */
    if (shop.leadStage && ['new', 'contacted', 'qualified', 'negotiation'].includes(shop.leadStage)) {
      reasons.push('An open lead');
      worth += WORTH.openLead;
    }

    if (!shop.lastVisitDate) {
      reasons.push('Never visited');
      worth += WORTH.notSeenLately;
    }

    if (!worth) continue;

    /* Distance as a COST against what the stop is worth, rather than as the
       sort key. Two hundred metres is nearly free; four kilometres has to earn
       itself. */
    out.push({ shop, metres, reasons, score: worth - (metres / 1000) * perKm });
  }

  /* Score first, then distance as the tiebreaker — two shops with the same
     reason are visited nearest-first, which is the only place proximity
     legitimately decides anything. */
  return out.sort((a, b) => b.score - a.score || a.metres - b.metres);
}

/**
 * The single best stop from here, or null.
 *
 * §G's "Next Best Visit". It is the head of the same list rather than a second
 * calculation, so the button and the list can never recommend different shops —
 * which is the sort of disagreement that makes somebody stop trusting both.
 */
export function nextBestVisit<T extends NearbyInput>(
  from: Coords,
  shops: T[],
  options: NearbyOptions,
): NearbyResult<T> | null {
  return nearby(from, shops, options)[0] ?? null;
}
