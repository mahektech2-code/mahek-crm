import "server-only";
import type { SnappedRun } from "@/lib/engines/snap-plan";

/* ---------------------------------------------------------------------------
 * THE ROAD LINES WE HAVE ALREADY BOUGHT, held for one day at a time.
 *
 * WHY IT IS SERVER-SIDE AND NOT THE BROWSER'S. `street-map.tsx` already holds
 * a road line per salesman in a ref, which is why deselecting and reselecting
 * a name costs nothing — but that cache lives and dies with one tab. Two
 * managers watching the same team pay for the same day twice, a reload pays
 * for it again, and neither of them can see that the other has already asked.
 * Held here, the second reader of a day costs nothing at all and the first
 * reader after a refresh costs only the walking since. That is the whole
 * difference between a bill that scales with MANAGERS and one that scales with
 * WALKING, and only walking is bounded.
 *
 * WHY IN MEMORY AND NOT A TABLE. A table survives a redeploy and would be the
 * obvious choice if this were worth keeping. It is not: every entry here is a
 * disposable, re-derivable second geometry — the service's own header says so
 * of the whole feature — and the raw fixes it is derived from are in Postgres
 * either way. A table would put a WRITE on a request that is read-only today,
 * add a migration and a nightly sweep for rows nobody reads after midnight,
 * and buy back exactly one thing: the first look after a deploy. That look
 * costs one day's snap per salesman, which is what EVERY look costs today, so
 * the worst case of losing this cache is the behaviour we are replacing.
 *
 * WHAT IT COSTS IF THE APP RUNS AS MORE THAN ONE PROCESS. One cache per
 * instance, so the saving is divided by however many there are — a bounded
 * multiple of the best case, still far below the per-browser cost it replaces,
 * and never worse than not caching at all. MahekOne runs as a single container
 * beside its Postgres on the droplet (see DEPLOY.md), so today that multiple
 * is one.
 *
 * IT IS NEVER A SOURCE OF TRUTH. Nothing reads it but the Live map's line, and
 * every entry is checked against the fixes on every read: `planRun` will only
 * build on a held run whose start time, first fix and far-end fix all still
 * match what the database has just answered. Anything else is dropped and
 * bought again. So the two cannot disagree — a stale entry is not a wrong line,
 * it is an entry that fails its own check and is discarded. That is the
 * invalidation, and it is the only one: there is no explicit eviction on a
 * withdrawn fix, because none is needed.
 * ------------------------------------------------------------------------- */

type DayKey = string;

/* One entry per RUN of a day, in the order the day cuts them — the plan engine
   matches them by position and drops everything after a mismatch. */
const store = new Map<DayKey, { runs: (SnappedRun | undefined)[]; touchedMs: number }>();

/*
 * A CEILING, because a Map nothing ever removes from is a leak with a slow
 * fuse. A day's worth of road line for one salesman is a few thousand
 * coordinate pairs — tens of kilobytes — so a few hundred of these is a few
 * megabytes, which is roughly a fortnight of a nine-man team being looked at.
 * It is not configuration: nothing about this number is a business decision
 * somebody would want to argue about on a screen, and getting it wrong costs
 * a re-snap rather than a wrong answer.
 */
const MAX_DAYS_HELD = 200;

function keyFor(salesmanId: string, day: string): DayKey {
  return `${salesmanId}:${day}`;
}

export function heldRunsFor(salesmanId: string, day: string): (SnappedRun | undefined)[] {
  const entry = store.get(keyFor(salesmanId, day));
  if (!entry) return [];
  entry.touchedMs = Date.now();
  return entry.runs;
}

export function holdRunsFor(
  salesmanId: string,
  day: string,
  runs: (SnappedRun | undefined)[],
): void {
  store.set(keyFor(salesmanId, day), { runs, touchedMs: Date.now() });
  if (store.size <= MAX_DAYS_HELD) return;
  /* Least recently looked at goes first: the day somebody is watching now is
     the day the next request will be about. */
  const oldest = [...store.entries()].sort((a, b) => a[1].touchedMs - b[1].touchedMs);
  for (const [key] of oldest.slice(0, store.size - MAX_DAYS_HELD)) store.delete(key);
}

/** For tests and for a console that wants to say how much has been bought. */
export function heldDayCount(): number {
  return store.size;
}
