import { requireUser } from "@/lib/auth";
import { can } from "@/lib/access-control";
import { customerLedger } from "@/lib/services/receipt-service";
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

  return (
    <LedgerScreen
      canReverse={can(user.role, "payment.confirm")}
      ledger={ledger}
      from={params.from ?? ""}
      to={params.to ?? ""}
    />
  );
}
