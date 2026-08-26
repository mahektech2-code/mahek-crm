import {
  isReportPeriod,
  reportRange,
  type BusinessDate,
  type DateRange,
  type ReportPeriod,
} from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * The Founder Dashboard's own period parsing — Reports' `readParams` without
 * the salesperson/region/city filters, which this app deliberately does not
 * offer: it is a company-wide reading, not a filtered one, and the apps it
 * rolls up are where a narrower question already gets asked.
 * ------------------------------------------------------------------------- */

export type FounderQuery = { period?: string };

export function readPeriod(
  params: FounderQuery,
  today: BusinessDate,
): { period: ReportPeriod; range: DateRange } {
  const period: ReportPeriod = isReportPeriod(params.period) ? params.period : "month";
  return { period, range: reportRange(today, period) };
}
