import { outstandingPage } from "@/lib/services/payment-service";
import { OutstandingScreen } from "./outstanding-screen";
import { readOutstandingParams, type OutstandingSearchParams } from "@/lib/outstanding-params";

export const metadata = { title: "Outstanding — Accounts — MahekOne" };

/**
 * Who owes us money.
 *
 * The bill ledger is cut by financial year because it describes what was
 * billed. This describes what is still OPEN, so it is deliberately not cut by
 * anything: the oldest debt on an account is usually last year's, and that is
 * the first row anybody chases.
 *
 * What it IS cut by is the page. This used to read every open bill in the book
 * and hand every one of them to the browser — 3.3 MB of it — under a nested
 * list per customer, so that twenty-five names could be shown. The figures
 * above the table still describe every customer the filters match, from
 * Postgres rather than from an array that happened to be lying around.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<OutstandingSearchParams>;
}) {
  const params = readOutstandingParams(await searchParams);
  const result = await outstandingPage(params);

  return (
    <OutstandingScreen
      rows={result.rows}
      total={result.total}
      page={result.page}
      perPage={result.perPage}
      totals={result.totals}
      query={params.query}
      sort={params.sort}
      overdueOnly={params.overdueOnly}
    />
  );
}
