import { customerLedger } from "@/lib/services/receipt-service";
import { LedgerScreen } from "./ledger-screen";

export const metadata = { title: "Customer account — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;

  // The customer lives in the URL, so a statement can be sent to somebody as a
  // link and comes back to the same account on reload.
  const ledger = params.customer
    ? await customerLedger(params.customer, { from: params.from, to: params.to })
    : null;

  return (
    <LedgerScreen
      ledger={ledger}
      from={params.from ?? ""}
      to={params.to ?? ""}
    />
  );
}
