import { requireUser } from "@/lib/auth";
import { can } from "@/lib/access-control";
import { customerLedger } from "@/lib/services/receipt-service";
import { accountServing } from "@/lib/services/distributor-service";
import { LedgerScreen } from "./ledger-screen";

export const metadata = { title: "Customer account — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const user = await requireUser();

  // The customer lives in the URL, so a statement can be sent to somebody as a
  // link and comes back to the same account on reload.
  const ledger = params.customer
    ? await customerLedger(params.customer, { from: params.from, to: params.to })
    : null;

  /*
   * HOW THIS ACCOUNT IS SERVED, on the one screen in Accounts where somebody
   * asks why a customer has no bills.
   *
   * A third-party customer never will have any — we deliver to it and its
   * distributor is invoiced — and a statement of nothing, with nothing on the
   * screen saying why, reads as data missing rather than as the arrangement
   * working exactly as intended. Read-only here: converting is a manager's,
   * and an accounts user holds no `customer.classify`.
   */
  const serving = ledger ? await accountServing(ledger.customerId) : null;

  return (
    <LedgerScreen
      canReverse={can(user.role, "payment.confirm")}
      ledger={ledger}
      serving={serving}
      from={params.from ?? ""}
      to={params.to ?? ""}
    />
  );
}
