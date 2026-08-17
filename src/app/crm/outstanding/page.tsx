import { requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { listOutstandingByCustomer } from "@/lib/services/payment-service";
import { outstandingTotals } from "@/lib/engines/outstanding";
import { OutstandingScreen } from "./outstanding-screen";

export const metadata = { title: "Outstanding - MahekOne CRM" };

/**
 * Who owes what, in the telecaller's own book.
 *
 * The same read the Accounts app's screen runs — one definition of "what does
 * this customer owe", scoped by `listBills`, so the two apps can never quote a
 * customer two different balances. What differs is what surrounds it: this one
 * links every row into the customer record and the WhatsApp reminder, which is
 * where a chase actually happens.
 */
export default async function OutstandingPage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const rows = await listOutstandingByCustomer();

  return (
    <OutstandingScreen
      rows={rows}
      totals={outstandingTotals(rows)}
      scopeLabel={scopeLabel(scope, user)}
    />
  );
}
