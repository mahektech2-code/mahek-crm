import type { AreaChoice } from './lead-areas';
import { haversineMetres, type Coords } from './geo';

/**
 * FINDING HIS AREA IN A LIST OF A THOUSAND.
 *
 * The New lead form drew every allocated area as a chip, which is right for
 * three and unusable for three hundred — and a salesman allocated a district
 * beat by beat carries well over a thousand. A wall of chips that long is not
 * a choice, it is a scroll, and the one he wants is found by luck. So the
 * picker answers two questions instead, in this order:
 *
 *   1. WHERE IS HE STANDING? A lead is raised at the shop, so the area is
 *      almost always one his own shops are in, near where he is now. His book
 *      already knows that — every pinned customer carries a town and a beat —
 *      so the areas with his shops within `NEAR_M` of the last fix are offered
 *      first, nearest first, with no typing at all. Then the ones he picked
 *      last, because a man works one beat for a week.
 *
 *   2. WHAT IS IT CALLED? Everything else is a search, not a browse. Typing
 *      "sad" finds Sadar; typing "nagpur" finds Nagpur and every beat in it,
 *      because the parent is searched as well as the name. Without a query the
 *      list is ordered by how many of HIS shops each area holds — the areas he
 *      actually works rise, the ones allocated for completeness sink — and it
 *      is capped, with the count of the rest said in words rather than drawn.
 *
 * Pure, like every engine: the book, the fix and the recent keys come in as
 * arguments, so the ordering a salesman sees is testable without a phone.
 */

/**
 * Shops in his book, reduced to what places them. `n` is how many shops share
 * this town, area and beat — the count arrives grouped, so a book of thousands
 * is a few hundred rows — and is 1 for a single pinned shop near him.
 */
export type BookPlace = {
  city: string | null;
  area: string | null;
  beat: string | null;
  lat: number | null;
  lng: number | null;
  n?: number;
};

export type AreaFacts = {
  /** How many of his shops are in it. Null for a whole state: the book has no state column to count by. */
  shops: number | null;
  /** Metres to the nearest of his shops in it, where one is within `NEAR_M` of the fix. */
  nearM: number | null;
};

export type Suggestion = { choice: AreaChoice; why: 'near' | 'recent'; nearM: number | null };

/** Close enough that the shop he is standing in is probably in the same area. */
export const NEAR_M = 3000;
/** How many rows the list draws before it asks him to type. */
export const LIST_LIMIT = 60;

/** Lower case, accents and punctuation gone, spaces collapsed — "Sadar Bazar (W)" and "sadar bazar w" are one name. */
export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-෿]+/g, ' ')
    .trim();
}

/** The word the area is known by: the beat, else the town, else the state. */
export function areaName(c: AreaChoice): string {
  return c.area ?? c.city ?? c.state ?? c.label;
}

/** What it sits inside, for the line under the name. */
export function areaParent(c: AreaChoice): string | null {
  if (c.area) return c.city ?? c.state;
  if (c.city) return c.state;
  return null;
}

/* The keys a choice and a shop are matched on. A beat is matched on its town
   AND its name where the allocation names the town, and on the name alone
   where it does not — the office writes a beat's town as its parent, and an
   older allocation may carry none. */
function choiceKey(c: AreaChoice): string | null {
  if (c.area) return c.city ? `l|${norm(c.city)}|${norm(c.area)}` : `l||${norm(c.area)}`;
  if (c.city) return `c|${norm(c.city)}`;
  return null;
}

function placeKeys(p: BookPlace): string[] {
  const keys = new Set<string>();
  const city = norm(p.city);
  if (city) keys.add(`c|${city}`);
  for (const local of [norm(p.area), norm(p.beat)]) {
    if (!local) continue;
    keys.add(`l||${local}`);
    if (city) keys.add(`l|${city}|${local}`);
  }
  return [...keys];
}

/**
 * Per choice: how many of his shops it holds, and how near the nearest one
 * is. `book` is his shops grouped by place, for the counts; `nearby` is the
 * pinned shops around the fix, for the distances. One pass over each,
 * whatever the number of areas — a map lookup per choice, not a product.
 */
export function areaFacts(
  choices: AreaChoice[],
  book: BookPlace[],
  fix: Coords | null,
  nearby: BookPlace[] = book,
): Map<string, AreaFacts> {
  const counts = new Map<string, number>();
  const nearest = new Map<string, number>();
  for (const p of book) {
    for (const k of placeKeys(p)) counts.set(k, (counts.get(k) ?? 0) + (p.n ?? 1));
  }
  if (fix) {
    for (const p of nearby) {
      if (p.lat == null || p.lng == null) continue;
      const d = haversineMetres(fix, { lat: p.lat, lng: p.lng });
      if (d > NEAR_M) continue;
      for (const k of placeKeys(p)) if (d < (nearest.get(k) ?? Infinity)) nearest.set(k, d);
    }
  }
  const out = new Map<string, AreaFacts>();
  for (const c of choices) {
    const k = choiceKey(c);
    out.set(c.key, {
      shops: k ? (counts.get(k) ?? 0) : null,
      nearM: k ? (nearest.get(k) ?? null) : null,
    });
  }
  return out;
}

/** The few offered before he types anything: near him first, then his recent picks. */
export function suggestAreas(
  choices: AreaChoice[],
  facts: Map<string, AreaFacts>,
  recentKeys: string[],
  max = 5,
): Suggestion[] {
  const out: Suggestion[] = [];
  const taken = new Set<string>();
  const near = choices
    .filter((c) => facts.get(c.key)?.nearM != null)
    .sort((a, b) => facts.get(a.key)!.nearM! - facts.get(b.key)!.nearM!)
    .slice(0, 3);
  for (const c of near) {
    out.push({ choice: c, why: 'near', nearM: facts.get(c.key)!.nearM });
    taken.add(c.key);
  }
  const byKey = new Map(choices.map((c) => [c.key, c]));
  for (const k of recentKeys) {
    if (out.length >= max) break;
    const c = byKey.get(k);
    if (!c || taken.has(k)) continue;
    out.push({ choice: c, why: 'recent', nearM: null });
    taken.add(k);
  }
  return out;
}

/* How well one choice answers the query; lower is better, null is no match.
   Every word typed has to land somewhere — "sadar nag" is Sadar in Nagpur and
   not every Sadar in the state. */
function score(c: AreaChoice, words: string[], whole: string): number | null {
  const name = norm(areaName(c));
  const parent = norm(areaParent(c));
  const hay = `${name} ${parent}`;
  const hayWords = hay.split(' ');
  for (const w of words) {
    if (!hayWords.some((h) => h.startsWith(w)) && !hay.includes(w)) return null;
  }
  if (name === whole) return 0;
  if (name.startsWith(whole)) return 1;
  if (name.split(' ').some((n) => n.startsWith(words[0]))) return 2;
  if (parent.startsWith(words[0])) return 3;
  return 4;
}

/**
 * The list under the search box. Without a query, every area by how many of
 * his shops it holds; with one, the matches by how well they match, then the
 * same. `total` is how many qualified, so the screen can say what it left out.
 */
export function searchAreas(
  choices: AreaChoice[],
  facts: Map<string, AreaFacts>,
  query: string,
  limit = LIST_LIMIT,
): { rows: AreaChoice[]; total: number } {
  const shops = (c: AreaChoice) => facts.get(c.key)?.shops ?? -1;
  const byWeight = (a: AreaChoice, b: AreaChoice) =>
    shops(b) - shops(a) || areaName(a).localeCompare(areaName(b));

  const whole = norm(query);
  if (!whole) {
    const rows = [...choices].sort(byWeight);
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  const words = whole.split(' ');
  const scored: { c: AreaChoice; s: number }[] = [];
  for (const c of choices) {
    const s = score(c, words, whole);
    if (s != null) scored.push({ c, s });
  }
  scored.sort((a, b) => a.s - b.s || byWeight(a.c, b.c));
  return { rows: scored.slice(0, limit).map((x) => x.c), total: scored.length };
}

/** "0.4 km", "2.1 km" — the same rounding the nearby list prints. */
export function nearLabel(m: number): string {
  return m < 1000 ? `${Math.max(0.1, Math.round(m / 100) / 10).toFixed(1)} km` : `${(m / 1000).toFixed(1)} km`;
}

/** The most recent first, no repeats, at most `max`. */
export function rememberArea(recent: string[], key: string, max = 6): string[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, max);
}
