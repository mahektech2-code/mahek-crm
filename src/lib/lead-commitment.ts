/* ---------------------------------------------------------------------------
 * §3.4 — WHAT MAKES A COMMITMENT A COMMITMENT, and it is a day AND a size.
 *
 * Mahek's answer, in his own words: the salesman records an Expected Order
 * Date AND an Expected Quantity OR an Expected Order Value. A customer who
 * says "I will order around the 25th" and cannot say how much has given us a
 * follow-up, not a commitment, and the forecast must not count it.
 *
 * THE RULE USED TO BE EITHER HALF, and the reasoning was reasonable: a date
 * with no value and a value with no date were both read as somebody having
 * asked the question and written the answer down, and demanding both would
 * read a half-recorded commitment as none. What that cost is exactly what
 * this file exists to stop — a date alone put the lead on the forecast board,
 * added it to the "expected this week" count, and escalated the sales
 * manager's verb in Negotiation to "Confirm actual order". Four screens said
 * a customer had promised something, and not one of them could say how much,
 * because nobody had ever asked.
 *
 * SO A DATE ALONE IS STILL RECORDED, and that is the half worth stating
 * loudest. `askForFirstOrder` writes it, the record shows it, the nurture
 * sweep still raises the call on the day that was named — it simply is not
 * COUNTED as a commitment. A screen that refused the save because the
 * salesman did not know the quantity would lose the one fact he did come back
 * with, and a salesman who loses an answer twice stops typing them in.
 *
 * EITHER the quantity OR the value satisfies it, and never both, because at
 * commitment there is often no SKU: "about five hundred litres" is said long
 * before anybody knows which pack it comes in, and `products.priceSource` is
 * still `unset` so nothing here can turn one into the other. Quantity is CANS,
 * which is what every other quantity in MahekOne stores and what a customer
 * actually says.
 *
 * PURE AND CLIENT-SAFE, and deliberately importing nothing at all — not even
 * drizzle's `sql`, which `lib/order-status.ts` beside it does. The first-order
 * form is a client component and has to draw the same verdict the services
 * count, so the SQL half is returned as a STRING that a service wraps in
 * `sql.raw`. One rule, one file, and no reason for a screen and a query to
 * disagree about one lead.
 * ------------------------------------------------------------------------- */

/** The three columns, and nothing else about the lead. */
export type CommitmentFacts = {
  expectedOrderDate: string | null | undefined;
  /** CANS. See the schema comment on `lead_expected_order_cans`. */
  expectedOrderCans: number | null | undefined;
  expectedOrderValuePaise: number | null | undefined;
};

/**
 * `none` — nobody has asked, or nobody wrote the answer down.
 * `expected` — a day, and no idea how much. A follow-up; §3.4 keeps it.
 * `confirmed` — a day and a size. The only one anything may count.
 */
export type CommitmentState = "none" | "expected" | "confirmed";

function given(n: number | null | undefined): boolean {
  /*
   * ZERO IS NOT AN ANSWER on either of these. A customer who says they will
   * take nothing has not committed to an order, they have declined one, and
   * an expected value of ₹0 counted as a commitment would put a lead on the
   * forecast board promising nothing.
   */
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export function commitmentState(f: CommitmentFacts): CommitmentState {
  if (!f.expectedOrderDate) return "none";
  return given(f.expectedOrderCans) || given(f.expectedOrderValuePaise)
    ? "confirmed"
    : "expected";
}

/** The one question every counter asks. */
export function isConfirmedCommitment(f: CommitmentFacts): boolean {
  return commitmentState(f) === "confirmed";
}

/**
 * WHAT IS MISSING, said in the words the person reading it has to act on.
 *
 * A refusal that does not say what it wants teaches somebody to press the
 * button again rather than to do the work — the same argument `lead-gates.ts`
 * makes about every rung. This one is not a refusal, because the save goes
 * through either way; it is what the form and the save's own message print so
 * nobody finds out weeks later that a promise was never counted.
 */
export function commitmentGap(f: CommitmentFacts): string | null {
  switch (commitmentState(f)) {
    case "confirmed":
      return null;
    case "expected":
      return "How much, or what it is worth. A day on its own is a follow-up rather than a commitment, so this will not be counted in the forecast.";
    case "none":
      return "The day they said they would place it. Without one there is nothing to chase and nothing to forecast.";
  }
}

/** One phrasing of the size, so three screens cannot word it three ways. */
export function commitmentSizeLabel(
  f: CommitmentFacts,
  money: (paise: number) => string,
): string {
  const parts: string[] = [];
  if (given(f.expectedOrderCans)) {
    const n = f.expectedOrderCans as number;
    parts.push(`${n} ${n === 1 ? "can" : "cans"}`);
  }
  if (given(f.expectedOrderValuePaise)) parts.push(money(f.expectedOrderValuePaise as number));
  /* Not "0" and not a blank: nobody asked, and an invented zero reads as a
     customer who said they would take nothing. */
  return parts.length ? parts.join(" · ") : "No quantity or value given";
}

/* --------------------------------------------------------------- for SQL */

/**
 * The same rule for a query. Pass the alias the query uses —
 * `confirmedCommitmentSql("c")` inside a join, `confirmedCommitmentSql(
 * "customers")` at the top level — and qualify it yourself, because Drizzle
 * renders a bare column that binds to the INNER table of a correlated
 * subquery and the condition silently becomes false.
 *
 * It returns a string rather than a `SQL` so this file can stay free of
 * drizzle and be imported by a client component; the caller wraps it in
 * `sql.raw`. The columns are our own and nothing here comes from a user, so
 * there is nothing to parameterise.
 */
export function confirmedCommitmentSql(alias: string): string {
  return `(${alias}.lead_expected_order_date is not null
        and (${alias}.lead_expected_order_cans > 0
          or ${alias}.lead_expected_order_value_paise > 0))`;
}

/**
 * The weaker half, named so a reader can tell which question is being asked.
 *
 * "Somebody asked and wrote a day down" and "there is a commitment" are two
 * different facts about a lead now, and a query spelling `…_date is not null`
 * leaves the next reader to guess which one was meant.
 */
export function commitmentRecordedSql(alias: string): string {
  return `(${alias}.lead_expected_order_date is not null)`;
}
