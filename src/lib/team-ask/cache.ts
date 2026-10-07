/* ---------------------------------------------------------------------------
 * The Ask panel's memory, so a question reaches the database only when it has
 * to.
 *
 * Three things are remembered, each for as long as it stays true enough:
 *
 *  - WHAT A PERSON MAY READ (their scope, their screens, the views that
 *    express them, the prompt that describes them) — minutes. It changes when
 *    somebody edits their access or their territory, which is rare, and
 *    resolving it is a handful of queries every question would otherwise pay.
 *  - WHAT A QUERY RETURNED — under a minute. Keyed on the VISIBILITY the
 *    query ran under (a hash of the exact view definitions) and the query's
 *    normalised text, so two managers who can see exactly the same rows share
 *    an answer, and two who see different rows never can.
 *  - WHAT A QUESTION WAS ANSWERED — a couple of minutes, for a fresh question
 *    only (a follow-up's meaning depends on the conversation before it).
 *
 * In memory and per process, deliberately: every entry is re-derivable from
 * the database, so losing it costs one slower answer and never a wrong one,
 * and a table would put a write on every read-only question.
 *
 * PURE apart from the clock, which is injectable for the tests.
 * ------------------------------------------------------------------------- */

export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert so the Map's order is least-recently-used first.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * A query's text as a cache key: case-folded and whitespace-collapsed OUTSIDE
 * string literals, so `SELECT  count(*)` and `select count(*)` are one entry
 * and `'Mahesh'` and `'mahesh'` stay two.
 */
export function normaliseSql(sql: string): string {
  const out: string[] = [];
  const re = /'(?:[^']|'')*'/g;
  let last = 0;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    out.push(sql.slice(last, m.index).toLowerCase().replace(/\s+/g, " "));
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  out.push(sql.slice(last).toLowerCase().replace(/\s+/g, " "));
  return out.join("").trim().replace(/;$/, "").trim();
}

/** A question as a cache key: what was asked, not how it was typed. */
export function normaliseQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[?.!,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
