/* ---------------------------------------------------------------------------
 * WHAT THE STOCK CACHE MAY HOLD — counted in ROWS, not in entries.
 *
 * The cache kept forty-eight answers whatever their size, and an answer whose
 * stamp had moved on stayed until the same statement was asked again. That was
 * harmless while a ledger was a few hundred rows. On the real book one answer
 * is ten thousand — every FG lot, every packing line — and a statement that
 * names the lots on one page is a new key with every page, so the cache kept
 * filling with answers nothing would ever ask for again, across every request,
 * until the server ran out of heap in the middle of a sheet sync.
 *
 * So what is kept is bounded three ways:
 *  - a STALE stamp empties the cache: the stamp only ever moves forward, so an
 *    answer under an older one can never be asked for again;
 *  - the answers kept add up to at most `maxRows` rows, the oldest dropped first;
 *  - a statement carrying more than `maxParams` parameters is not kept at all —
 *    that is a page's own list of lots, read once.
 *
 * PURE, so the rules have tests that need no database.
 * ------------------------------------------------------------------------- */

export type CachePolicy = { maxRows: number; maxParams: number };

export const LEDGER_CACHE_POLICY: CachePolicy = { maxRows: 50_000, maxParams: 200 };

/** The second cache, for the few reads that name an order table (`ledger-cache.ts`) — small answers, and the two together keep the old 60,000-row ceiling. */
export const LEDGER_CACHE_POLICY_ORDERS: CachePolicy = { maxRows: 10_000, maxParams: 200 };

type Entry<V> = { stamp: string; value: V; rows: number };

export class StampedRowCache<V> {
  private kept = new Map<string, Entry<V>>();
  private stamp: string | null = null;
  private total = 0;

  constructor(private readonly policy: CachePolicy) {}

  /** Whether a statement with this many parameters may be kept at all. */
  admits(params: number): boolean {
    return params <= this.policy.maxParams;
  }

  /**
   * The answer kept under `stamp`, or nothing. A stamp other than the one the
   * cache is on empties it first — stamps are compared for equality, not
   * order, and the caller has just read this one, so it is the current one.
   */
  get(key: string, stamp: string): V | undefined {
    this.observe(stamp);
    const at = this.kept.get(key);
    if (!at || at.stamp !== stamp) return undefined;
    this.kept.delete(key);
    this.kept.set(key, at);
    return at.value;
  }

  /**
   * Keeps an answer of `rows` rows, then drops the oldest until the budget
   * holds. One answer over the whole budget is not kept.
   *
   * An answer under a stamp the cache has since LEFT is not kept, and moves
   * nothing. A read that started before a write lands after it; re-keeping it
   * under its own stamp emptied the cache of every answer read since the write
   * and pinned it to a stamp no page would ask for again. Only `get` moves the
   * stamp, because only `get` is handed one just read.
   */
  set(key: string, stamp: string, value: V, rows: number): void {
    if (this.stamp === null) this.observe(stamp);
    if (stamp !== this.stamp) return;
    this.drop(key);
    if (rows > this.policy.maxRows) return;
    this.kept.set(key, { stamp, value, rows });
    this.total += rows;
    while (this.total > this.policy.maxRows) {
      const oldest = this.kept.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  /** Forgets `key` — only while it still holds `value`, when one is named, so a failed read cannot take a newer answer with it. */
  drop(key: string, value?: V): void {
    const at = this.kept.get(key);
    if (!at || (value !== undefined && at.value !== value)) return;
    this.kept.delete(key);
    this.total -= at.rows;
  }

  /** Rows and answers held now — what the tests, and a curious admin, read. */
  size(): { entries: number; rows: number } {
    return { entries: this.kept.size, rows: this.total };
  }

  private observe(stamp: string): void {
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.kept.clear();
    this.total = 0;
  }
}
