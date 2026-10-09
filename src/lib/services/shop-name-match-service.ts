import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, fieldActivityCustomerDecisions } from "@/db/schema";
import {
  decideCustomerMatch,
  foldShopName,
  type CustomerCandidate,
  type MatchResult,
  type ShopCandidate,
} from "@/lib/field-activity-match";

/* ---------------------------------------------------------------------------
 * A typed shop name -> an account, for the importers that only have a name.
 *
 * The book and the people's decisions are read ONCE per run and held in
 * memory: an exact name is a map lookup, so linking costs nothing and cannot
 * drift into "close enough". The trigram search runs only for a name with no
 * exact account and no decision, and only to SHOW a person the shortlist —
 * `decideCustomerMatch` never links on it.
 * ------------------------------------------------------------------------- */

export type ShopBook = Map<string, ShopCandidate[]>;
export type NameDecisions = Map<string, { customerId: string | null }>;

export async function loadShopBook(): Promise<ShopBook> {
  const rows = await db
    .select({ id: customers.id, name: customers.name, city: customers.city })
    .from(customers);
  const book: ShopBook = new Map();
  for (const r of rows) {
    const key = foldShopName(r.name);
    if (!key) continue;
    const list = book.get(key) ?? [];
    list.push(r);
    book.set(key, list);
  }
  return book;
}

export async function loadNameDecisions(): Promise<NameDecisions> {
  const rows = await db
    .select({
      nameKey: fieldActivityCustomerDecisions.nameKey,
      customerId: fieldActivityCustomerDecisions.customerId,
    })
    .from(fieldActivityCustomerDecisions);
  return new Map(rows.map((r) => [r.nameKey, { customerId: r.customerId }]));
}

/** Close names, for a person to choose from. Never a link on their own. */
export async function nearShopNames(name: string, limit = 6): Promise<(CustomerCandidate & { city: string | null })[]> {
  const rows = await db.execute<{ id: string; name: string; city: string | null; score: number }>(sql`
    select id, name, city, similarity(lower(name), lower(${name})) as score
      from customers
     where name ilike ${`%${name}%`} or similarity(lower(name), lower(${name})) > 0.3
     order by similarity(lower(name), lower(${name})) desc
     limit ${limit}
  `);
  return rows.map((r) => ({ id: r.id, name: r.name, city: r.city, score: Number(r.score) }));
}

/**
 * A matcher for one run. `withNear` asks Postgres for close names on a miss —
 * worth it on an import, where a person will read the shortlist; a re-match of
 * thirty thousand stored rows leaves it off and keeps the note it had.
 */
export async function shopNameMatcher(options: { withNear?: boolean } = {}) {
  const [book, decisions] = await Promise.all([loadShopBook(), loadNameDecisions()]);
  const cache = new Map<string, MatchResult>();
  return {
    book,
    decisions,
    async match(name: string | null | undefined): Promise<MatchResult> {
      const key = foldShopName(name);
      if (!key) return { status: "unmatched", matchedId: null, note: null };
      const cached = cache.get(key);
      if (cached) return cached;
      const exact = book.get(key) ?? [];
      const decision = decisions.get(key) ?? null;
      const near =
        options.withNear !== false && !decision && exact.length === 0
          ? await nearShopNames(name!)
          : [];
      const result = decideCustomerMatch({ exact, near, decision });
      cache.set(key, result);
      return result;
    },
  };
}
