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

/**
 * The floor a customer-name candidate has to clear to be worth listing at
 * all — the same 0.25–0.35 range product search already uses for this
 * column of similarity.
 */
const CANDIDATE_FLOOR = 0.3;
/** How confident the top candidate has to be, alone, to auto-match. */
const MATCH_THRESHOLD = 0.6;
/** How far ahead of the runner-up the top candidate has to be. */
const MATCH_GAP = 0.1;

/**
 * 5,180 free-text shop names against a real customer book. A candidate that
 * clears the floor but isn't clearly the best of the shortlist is held for a
 * person rather than picked — the same "ambiguous, never auto-picked"
 * discipline `sheetOrderRows.productMatchStatus` already uses for a product
 * name that could mean five different brand lines.
 */
export function decideCustomerMatch(candidates: CustomerCandidate[]): MatchResult {
  const ranked = [...candidates]
    .filter((c) => c.score >= CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return { status: "unmatched", matchedId: null, note: null };

  const [top, second] = ranked;
  const clear = top.score >= MATCH_THRESHOLD && (!second || top.score - second.score >= MATCH_GAP);

  if (clear) return { status: "matched", matchedId: top.id, note: null };

  const shortlist = ranked
    .slice(0, 5)
    .map((c) => `${c.name} (${c.score.toFixed(2)})`)
    .join(", ");
  return { status: "ambiguous", matchedId: null, note: `Candidates: ${shortlist}` };
}
