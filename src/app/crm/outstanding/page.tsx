import { requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { outstandingPage } from "@/lib/services/payment-service";
import { OutstandingScreen } from "./outstanding-screen";
import {
  readOutstandingParams,
  type OutstandingSearchParams,
} from "@/lib/outstanding-params";

export const metadata = { title: "Outstanding - MahekOne CRM" };

/**
 * Who owes what, in the telecaller's own book.
 *
 * The same read the Accounts app's screen runs — one definition of "what does
 * this customer owe", scoped by `listBills`, so the two apps can never quote a
 * customer two different balances. What differs is what surrounds it: this one
 * links every row into the customer record and the WhatsApp reminder, which is
 * where a chase actually happens.
 *
 * It reads the URL the same way that screen does, from the same function: two
 * readings of `?sort=` would be two screens that disagree about what an
 * unrecognised one means.
 */
export default async function OutstandingPage({
  searchParams,
}: {
  searchParams: Promise<OutstandingSearchParams>;
}) {
  const user = await requireUser();
  const scope = await getScope(user);
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
      scopeLabel={scopeLabel(scope, user)}
    />
  );
}
