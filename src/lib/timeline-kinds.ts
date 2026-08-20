/* ---------------------------------------------------------------------------
 * What a customer's timeline is made of.
 *
 * PURE and client-safe, like the complaint labels and the account types beside
 * it, because both ends need the list: `lib/queries.ts` composes one SQL
 * branch per kind, and the record screen draws one filter pill per kind and
 * asks the server for that kind alone. `queries.ts` is `server-only`, so the
 * screen cannot read the list from there — and a second copy written out in
 * the component is a filter that offers a kind the query cannot answer.
 *
 * The ORDER is the order the pills appear in, and it is deliberate: the things
 * a person did first, then the things the business did. A telecaller opening
 * this record is looking for the last conversation, not the last invoice.
 * ------------------------------------------------------------------------- */

/**
 * How many entries a page of the timeline is.
 *
 * TEN. It is the read a telecaller actually does before a call — the last few
 * things that happened — and "Load older" is one click from there. It lives
 * here rather than at the three places that need it (the record page's first
 * read, the paging action's default, and the sentence the screen prints) so
 * they cannot disagree about what "the newest page" means: a screen saying
 * "showing the newest 10" while the button fetched fifty would be two
 * different pages under one number.
 */
export const TIMELINE_PAGE = 10;

export const TIMELINE_KINDS = [
  "Call",
  "WhatsApp",
  "Complaint",
  "Reminder",
  "Order",
  "Payment",
  "Bill",
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];
