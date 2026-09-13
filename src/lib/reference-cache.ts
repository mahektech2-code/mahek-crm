import "server-only";

/**
 * A SMALL TTL CACHE FOR REFERENCE DATA, and nothing else.
 *
 * `react`'s `cache()` is used in ten places here and does a different job: it
 * dedupes a read WITHIN one render, so the sidebar and the page asking the
 * same question cost one query. It is discarded when the request ends. Until
 * this file there was exactly one thing in MahekOne that survived between
 * requests — `getConfig`, which keeps `app_settings` for 30 seconds — and
 * every other screen rebuilt everything from nothing, every time.
 *
 * That matters on this deployment specifically. The app runs on one shared
 * vCPU beside its own Postgres, so the scarce thing is not the database (the
 * hot reads measure 2–414 ms on the real book) but the core that has to parse
 * the rows and render the page. Work not done is the only work that is free.
 *
 * **WHAT BELONGS HERE IS NARROW, and the limits are the point:**
 *
 * - It must be the SAME for everybody. Anything scoped to a user or a book
 *   would need the key to carry the scope, and a scope key got subtly wrong is
 *   one person seeing another's data — the worst bug this codebase can have,
 *   and one no test would catch because it looks like working software.
 * - It must be SMALL. The heap here is capped at 320 MB and the box is already
 *   in swap; caching a list of ten thousand bills to save a query would buy a
 *   round trip and pay for it in GC on every request afterwards.
 * - It must change RARELY, and only through an admin action. A telecaller who
 *   saves a call and sees a stale list has been lied to by the screen.
 *
 * So: quick notes, the product starter list, call scripts. Not the queue, not
 * a customer list, not counts, not anything with a figure somebody acts on.
 *
 * **THE TTL IS THE WHOLE INVALIDATION STORY, deliberately.** `getConfig` took
 * this decision first and it has held: an explicit `invalidate()` on every
 * write path is a list somebody forgets to add to, and the failure is a value
 * that is wrong until the process restarts. Thirty seconds of staleness on a
 * list of quick notes is not a thing anybody can notice; a permanently stale
 * one is. `forget()` exists for tests and for an admin screen that wants to
 * prove its own save landed.
 */

const TTL_MS = 30_000;

type Entry = { value: unknown; readAt: number };

const entries = new Map<string, Entry>();
/** In flight, so ten concurrent requests on a cold key make ONE query. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Read through the cache, or fill it.
 *
 * The stampede guard is not decoration on a single-core box: without it, the
 * first ten requests after a deploy all miss, all query, and all parse — which
 * is precisely the moment the process has the least CPU to spare.
 */
export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.readAt < TTL_MS) return hit.value as T;

  const running = inFlight.get(key);
  if (running) return running as Promise<T>;

  const promise = load()
    .then((value) => {
      entries.set(key, { value, readAt: Date.now() });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise as Promise<T>;
}

/** Drop one key, or everything. For tests and for an admin save that wants to
 *  see its own change immediately rather than in half a minute. */
export function forget(key?: string): void {
  if (key === undefined) entries.clear();
  else entries.delete(key);
}
