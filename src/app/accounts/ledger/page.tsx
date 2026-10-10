import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { customerStatement } from "@/lib/services/customer-statement-service";
import { accountServing } from "@/lib/services/distributor-service";
import { LedgerScreen } from "./ledger-screen";

export const metadata = { title: "Customer account — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    customer?: string;
    year?: string;
    from?: string;
    to?: string;
    view?: string;
  }>;
}) {
  const params = await searchParams;
  const user = await requireUser();

  // The period (financial year by default) and the statement for it — the
  // same function the CRM record's Ledger tab asks. See its header.
  const { ledger, period, years, today, from, to } = await customerStatement(params.customer, {
    year: params.year,
    from: params.from,
    to: params.to,
  });

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
      canReverse={await canFor(user, "payment.confirm")}
      ledger={ledger}
      serving={serving}
      period={period}
      years={years}
      today={today}
      from={from}
      to={to}
      view={params.view === "bills" ? "bills" : "statement"}
    />
  );
}
