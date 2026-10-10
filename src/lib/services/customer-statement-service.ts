import "server-only";
import { today as businessToday } from "../recompute";
import { currentYear, yearDates, yearKindOf, yearOptions } from "../year-period";
import { customerLedger, earliestLedgerDate, type CustomerLedger } from "./receipt-service";

/* ---------------------------------------------------------------------------
 * One customer's statement for a PERIOD — the read behind Accounts → Customer
 * account and the CRM customer record's Ledger tab.
 *
 * The period is a financial year by default, a calendar year, all time, or
 * dates somebody typed. Typed dates win where they are given, because they are
 * the most specific thing anybody asked for; "all" is every entry; any other
 * value is a year, and one the account has no entries in falls back to the
 * current financial year. Both screens ask this one function, so a link from
 * either opens the same statement.
 *
 * Scope is `customerLedger`'s, which throws for a customer the caller may not
 * see. The earliest date is read only after that check has passed.
 * ------------------------------------------------------------------------- */

export type StatementPeriodAsk = { year?: string; from?: string; to?: string };

export type CustomerStatement = {
  ledger: CustomerLedger | null;
  /** A year ("26-27" / "2026"), "all", or "custom". */
  period: string;
  years: { fy: string[]; cy: string[] };
  today: string;
  /** The period as inclusive dates; empty for all time. */
  from: string;
  to: string;
};

export async function customerStatement(
  customerId: string | undefined,
  ask: StatementPeriodAsk,
): Promise<CustomerStatement> {
  const day = await businessToday();
  const custom = Boolean(ask.from || ask.to) && !ask.year;
  const allTime = ask.year === "all";

  // Any well-formed year is honoured as asked — a calendar year before the
  // account's first bill is an empty statement, which is a true answer.
  // Anything else is the current financial year.
  const year =
    custom || allTime
      ? null
      : ask.year && yearKindOf(ask.year)
        ? ask.year
        : currentYear(day, "fy");
  const range: { from?: string; to?: string } = custom
    ? { from: ask.from || undefined, to: ask.to || undefined }
    : year
      ? yearDates(year)
      : {};

  // The ledger read is also the scope check, so it comes first and the
  // earliest date is asked only of an account the caller may see.
  const ledger = customerId ? await customerLedger(customerId, range) : null;
  const years =
    ledger && customerId
      ? yearOptions(await earliestLedgerDate(customerId), day)
      : yearOptions(null, day);
  // The year on screen is always one the picker offers.
  if (year && !years[yearKindOf(year)!].includes(year)) years[yearKindOf(year)!].push(year);

  return {
    ledger,
    period: custom ? "custom" : allTime ? "all" : year!,
    years,
    today: day,
    from: range.from ?? "",
    to: range.to ?? "",
  };
}
