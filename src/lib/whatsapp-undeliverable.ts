/* ---------------------------------------------------------------------------
 * A NUMBER WHATSAPP CANNOT DELIVER TO IS A FACT ABOUT THE NUMBER, not about
 * the sending.
 *
 * Meta answers 131026 "Message undeliverable" when the recipient cannot get
 * the message at all — the number is not on WhatsApp, has blocked the
 * business, or runs an app too old to receive it. Nothing on our side is
 * wrong, and sending again tomorrow changes nothing. Two things followed from
 * reading it as an ordinary failure:
 *
 *  - the WhatsApp screen's red "API sends failed" banner stood up for good,
 *    reading as broken sending when every other message was going out; and
 *  - the payment-reminder rule tried the same five numbers every day, because
 *    a failed message does not count as sent and so never starts the rule's
 *    repeat interval.
 *
 * So it is its own kind of failure. The rule skips the number, the screen
 * names the customers rather than raising an alarm, and nothing is written to
 * the customer: no DND, no flag. It is DERIVED from the messages themselves —
 * the newest message to the customer's CURRENT number — so correcting the
 * number, a later message that is delivered, or the customer writing to us
 * from it each clears it with nothing to reset.
 *
 * PURE and client-safe: the page decides the banner with it as well.
 * ------------------------------------------------------------------------- */

/** Meta's code for "this recipient cannot receive the message". */
export const UNDELIVERABLE_CODE = "131026";

/** Whether a stored failure reason says the NUMBER cannot receive WhatsApp. */
export function isUndeliverableNumber(reason: string | null | undefined): boolean {
  return typeof reason === "string" && new RegExp(`(^|\\D)${UNDELIVERABLE_CODE}(\\D|$)`).test(reason);
}

/** The same test, for SQL over `wa_messages.failure_reason`. */
export const UNDELIVERABLE_SQL_PATTERN = `(^|[^0-9])${UNDELIVERABLE_CODE}([^0-9]|$)`;

/** The sentence a skipped customer is logged with in the rule's run. */
export function undeliverableSkipReason(failedOn: string): string {
  return `WhatsApp could not deliver to this number on ${failedOn} — it may not be on WhatsApp. Correct the number to try again.`;
}
