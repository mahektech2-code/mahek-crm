/* ---------------------------------------------------------------------------
 * WHAT EACH SEAT ACTUALLY MOVES, in the words the screens use.
 *
 * An account has seats that look alike from a distance and do entirely
 * different things, and two of them are called nearly the same name:
 *
 *   sales          `sales_am_id`     — THE BOOK. `ASSIGNED_TO_SQL` reads it,
 *                                      so it decides the Call Log, collections,
 *                                      every scoped list, and — through
 *                                      `sales-attribution.ts` — whose target
 *                                      the account's orders count toward.
 *   sales manager  `sales_manager_*` — who the salesperson answers to. It is
 *                                      read by nothing: no queue, no list, no
 *                                      target. That is precisely why it is a
 *                                      manager's to move while the seat above
 *                                      is accounts' and admin's.
 *   back office    `back_office_am_id` — dispatch, billing, paperwork. Grants
 *                                      sight; credits nothing while the sales
 *                                      seat is filled.
 *
 * THIS FILE EXISTS BECAUSE THE DIFFERENCE COST SOMEBODY A BOOK. A salesperson
 * was recorded as having left; the back office seat was moved off her and the
 * sales seat was not, so forty-two accounts stayed in her Call Log and stayed
 * counting toward her targets. The follow-up attempt used the sales MANAGER
 * seat — twice, the second time with the reason "Correcting a mistake" — which
 * could not have moved anything. Nothing malfunctioned: three screens each
 * said something true and none of them said the one thing that mattered.
 *
 * The transfer dialog even carried both halves in one paragraph: "This is the
 * way to hand a whole book over when somebody leaves", and then, two sentences
 * later, that it changes nothing about whose book an account is in. The first
 * is the sentence somebody handling a departure reads.
 *
 * PURE and client-safe, like `seat-labels` beside it: these dialogs are client
 * components and there are three of them. A sentence typed into one screen is
 * a sentence that stops matching the other two.
 * ------------------------------------------------------------------------- */

/** What a reader of the transfer dialog has to know before they use it. */
export const SALES_MANAGER_IS_REPORTING_ONLY =
  "The sales manager is who the salesperson answers to. It is a reporting line: " +
  "it does not change whose book an account is in, whose Call Log it appears on, " +
  "or whose target its orders count toward.";

/** And where to go for the thing they may actually have meant. */
export const WHERE_THE_BOOK_MOVES =
  "To hand a book over, change the account manager · sales on the accounts " +
  "themselves — from Edit on a row, or from the account's own record.";

/**
 * The sentence shown when somebody changes the back office seat and leaves the
 * sales seat alone.
 *
 * Silence here is what the whole file is about: moving one seat is a perfectly
 * ordinary thing to do and must not be refused, but a form that has just been
 * told "salesperson left" and moved the paperwork seat should say, out loud,
 * that the book has not moved and who still holds it.
 *
 * `null` where there is nothing to warn about — the sales seat is moving too,
 * or it is not moving because nothing about this account's book is in
 * question.
 */
export function bookUnchangedNote(input: {
  changingSales: boolean;
  changingBackOffice: boolean;
  /** Who holds the sales seat as things stand. */
  salesHolder: string | null;
}): string | null {
  if (input.changingSales || !input.changingBackOffice) return null;
  return input.salesHolder
    ? `Whose book this account is in is not changing — it stays with ${input.salesHolder}. ` +
        "The back office seat is dispatch, billing and paperwork."
    : "Whose book this account is in is not changing — it has no salesperson. " +
        "The back office seat is dispatch, billing and paperwork.";
}
