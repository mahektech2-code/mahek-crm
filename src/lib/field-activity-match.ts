import { partyNameKey } from "@/lib/sheet-parse";

/* ---------------------------------------------------------------------------
 * Deciding a match from candidates already found. PURE — the actual lookups
 * (an exact-fold pass against `users`/`employees`, a trigram search against
 * `customers`) are SQL and live in the sync service; this is only the
 * decision of what a shortlist of candidates means, which is what needs to
 * be gotten right and is cheap to test without a database.
 * ------------------------------------------------------------------------- */

export type MatchStatus = "matched" | "ambiguous" | "unmatched";

export type MatchResult = {
  status: MatchStatus;
  matchedId: string | null;
  /** The candidates considered, for a person to read when it isn't `matched`. */
  note: string | null;
};

/**
 * The 25 salesmen on this sheet are a small, closed set — exact-fold
 * matching (same normalisation `recomputeSalesPeople` already uses to join
 * a sheet's free-text name to a real account: trim, collapse whitespace,
 * uppercase) is expected to resolve nearly all of them without anything
 * fuzzier. More than one account folding to the same name is `ambiguous`
 * rather than picked at random.
 */
export function matchSalesmanName(
  rawName: string | null,
  candidates: { id: string; name: string }[],
): MatchResult {
  const name = (rawName ?? "").trim();
  if (!name) return { status: "unmatched", matchedId: null, note: null };

  const key = partyNameKey(name);
  const hits = candidates.filter((c) => partyNameKey(c.name) === key);

  if (hits.length === 0) return { status: "unmatched", matchedId: null, note: null };
  if (hits.length === 1) return { status: "matched", matchedId: hits[0].id, note: null };
  return {
    status: "ambiguous",
    matchedId: null,
    note: `More than one account named "${name}": ${hits.map((h) => h.id).join(", ")}`,
  };
}

export type CustomerCandidate = { id: string; name: string; score: number };
/** An account carrying exactly the name asked about, once folded. */
export type ShopCandidate = { id: string; name: string; city?: string | null };

/**
 * One shop name, folded so that only spelling decides: case, spacing and
 * punctuation are not part of a name ("K. RAMSING SALES" is "K RAMSING
 * SALES"), every other character is. The same fold the shop-master
 * projection matches on, so the two importers agree about what "the same
 * name" means.
 */
export function foldShopName(name: string | null | undefined): string {
  return (name ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/** The floor a close name has to clear to be worth SHOWING to a person. */
const CANDIDATE_FLOOR = 0.3;

const describeShop = (c: ShopCandidate) => (c.city ? `${c.name} (${c.city})` : c.name);

/**
 * WHICH ACCOUNT A TYPED SHOP NAME IS — and a name is only ever linked on its
 * own where nothing could be wrong about it.
 *
 * This used to auto-link any name scoring 0.6 trigram similarity with a 0.1
 * lead over the runner-up, which links "Shree Ganesh Paints" to "Shree Ganesh
 * Paint House" and a shop in Ajmer to a namesake in Mumbai. Every such link
 * put somebody else's visit on a customer's timeline, read as fact. So:
 *
 *   1. a PERSON'S decision wins, whatever it says — including "not on
 *      MahekOne";
 *   2. exactly ONE account on the book with the same folded name is a match;
 *   3. several with that exact name is a question, listing them with towns;
 *   4. a close name is NEVER a match — it is a question with the shortlist;
 *   5. nothing close is unmatched.
 *
 * A wrong link is far worse than a held one: a held one is on the review
 * list saying so, a wrong one is on nobody's.
 */
export function decideCustomerMatch(input: {
  exact: ShopCandidate[];
  near?: CustomerCandidate[];
  /** What a person decided for this name, if anybody did. */
  decision?: { customerId: string | null; customerName?: string | null } | null;
}): MatchResult {
  if (input.decision) {
    return input.decision.customerId
      ? {
          status: "matched",
          matchedId: input.decision.customerId,
          note: "Linked by a person.",
        }
      : {
          status: "unmatched",
          matchedId: null,
          note: "A person decided this shop is not on MahekOne.",
        };
  }

  if (input.exact.length === 1) {
    return { status: "matched", matchedId: input.exact[0].id, note: null };
  }
  if (input.exact.length > 1) {
    return {
      status: "ambiguous",
      matchedId: null,
      note: `${input.exact.length} accounts carry exactly this name: ${input.exact
        .slice(0, 6)
        .map(describeShop)
        .join(", ")}`,
    };
  }

  const close = [...(input.near ?? [])]
    .filter((c) => c.score >= CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score);
  if (!close.length) return { status: "unmatched", matchedId: null, note: null };
  return {
    status: "ambiguous",
    matchedId: null,
    note: `No account has exactly this name. Close names: ${close
      .slice(0, 5)
      .map((c) => c.name)
      .join(", ")}`,
  };
}
