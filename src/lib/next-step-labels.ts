/* ---------------------------------------------------------------------------
 * WHAT HAPPENS NEXT WITH THIS CUSTOMER, in words.
 *
 * PURE and client-safe, like the complaint labels and the account types beside
 * it, because three screens now say it: the dialog that appears when a call is
 * saved, the Call history table, and the customers list. Written out in each,
 * they would drift — and the whole point of the stored next step is that the
 * sentence a telecaller reads out on a phone call is the one the queue engine
 * actually produced.
 *
 * TWO WORDS PER KIND, and they are not interchangeable. The long one is for a
 * dialog that has a whole line: it is read once, slowly, by somebody who has
 * just put the phone down. The short one is for a table cell beside a date,
 * read at a glance down a column of twenty-five — "You owe them this call" in
 * a 90px column is a sentence nobody finishes.
 * ------------------------------------------------------------------------- */

export type NextStepKind = "booked" | "scheduled" | "decide" | "none";

export const NEXT_STEP_LABELS: Record<
  NextStepKind,
  { tone: "brand" | "neutral" | "warn" | "muted"; word: string; short: string }
> = {
  /* A callback the customer asked for. A promise, not a prediction — which is
     why it is drawn differently from the line below it. */
  booked: { tone: "brand", word: "You owe them this call", short: "Promised" },
  /* A date the rules produced. It moves the moment they order, pay or ask for
     a callback, and that is not a caveat worth printing beside every one. */
  scheduled: { tone: "neutral", word: "Scheduled", short: "Scheduled" },
  /* Nobody could reach them and the ladder has run out. A person decides. */
  decide: { tone: "warn", word: "Needs a decision", short: "Needs a decision" },
  /* Nothing is coming back on its own: do not contact, or nothing left to
     chase. Carries NO date, and inventing one would be a fiction the
     telecaller has no way to check. */
  none: { tone: "muted", word: "Nothing scheduled", short: "Nothing scheduled" },
};

/** The kinds that genuinely carry no date. Never render a blank cell for them. */
export function hasNoDate(kind: NextStepKind): boolean {
  return kind === "decide" || kind === "none";
}
