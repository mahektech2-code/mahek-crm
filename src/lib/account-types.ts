/* ---------------------------------------------------------------------------
 * WHAT AN ACCOUNT IS TO US, as one question with three answers.
 *
 * Direct customer — we sell to them and we invoice them.
 * Lead            — they have never ordered, and we are trying to change that.
 * Third-party customer — a shop we DELIVER to and do not bill; a distributor
 *                   buys the goods and sells them on.
 *
 * PURE, and here rather than in the screen, because three places have to agree
 * about it: the customers list draws the badge, both list pages turn `?party=`
 * back into the control's own words, and the record pages say which kind of
 * account somebody is looking at. It was written out in each of them and the
 * two list pages had already drifted from the screen's copy.
 *
 * The mark WINS over the kind, deliberately. A third-party customer is still a
 * lead or a customer underneath — that is exactly what lets us bill one when
 * it starts ordering — but "Lead · Third party" is two facts fighting over one
 * glance on four hundred rows, and the one somebody scanning a list needs is
 * how the account is worked. The kind underneath is on the record, where there
 * is room to say it properly.
 * ------------------------------------------------------------------------- */

export const ALL_ACCOUNT_TYPES = "All types";

/** The word for a row, from the two columns that decide it. */
export function accountTypeLabel(row: {
  kind: string;
  thirdParty: boolean;
}): string {
  if (row.thirdParty) return "Third-party customer";
  return row.kind === "lead" ? "Lead" : "Direct customer";
}

/**
 * The type filter, and one of its options is not a type at all.
 *
 * "Delivered to on another's bill" is the EVIDENCE — the accounts the order
 * sheet shows taking goods somebody else was invoiced for, whether or not
 * anybody has converted them yet. It is the list the conversion work is
 * actually done from, and it was reachable only by typing `?party=delivered`
 * into the address bar before it was given a name here.
 */
export const ACCOUNT_TYPE_FILTERS = [
  ALL_ACCOUNT_TYPES,
  "Direct customers",
  "Leads",
  "Third-party customers",
  "Delivered to on another's bill",
  /* The tidying list, and it should be empty: converting names a distributor
     in the same transaction. What fills it is accounts converted before that
     was true, and a shop nobody bills is exactly the row somebody has to
     finish rather than one to leave off the screen. */
  "Third party, nobody billing",
] as const;

/** The control's own word → the query parameter `listCustomersPage` reads. */
export const ACCOUNT_TYPE_PARAM: Record<string, string | undefined> = {
  "Direct customers": "customer",
  Leads: "lead",
  "Third-party customers": "yes",
  "Delivered to on another's bill": "delivered",
  "Third party, nobody billing": "nodistributor",
};

/** The values `?party=` may carry. Anything else is no filter at all. */
export type AccountTypeParam =
  | "yes"
  | "no"
  | "delivered"
  | "lead"
  | "customer"
  | "nodistributor";

const ACCOUNT_TYPE_CODES = new Set<string>([
  "yes",
  "no",
  "delivered",
  "lead",
  "customer",
  "nodistributor",
]);

/**
 * `,`-separated CODES (never the control's words — those never leave the
 * screen). More than one is "any of these" — `customerFilterClause` ORs the
 * per-code clauses together. An unrecognised code is dropped rather than
 * carried through: `?party=nonsense` reaching the query as a value that
 * matches nothing would read as a lost book, not as a typo.
 */
export function accountTypeParam(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const codes = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => ACCOUNT_TYPE_CODES.has(v));
  return codes.length ? codes.join(",") : undefined;
}
