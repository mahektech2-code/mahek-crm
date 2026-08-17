import { listOutstandingByCustomer } from "@/lib/services/payment-service";
import { outstandingTotals } from "@/lib/engines/outstanding";
import { OutstandingScreen } from "./outstanding-screen";

export const metadata = { title: "Outstanding — Accounts — MahekOne" };

/**
 * Who owes us money.
 *
 * The bill ledger is cut by financial year because it describes what was
 * billed. This describes what is still OPEN, so it is deliberately not cut by
 * anything: the oldest debt on an account is usually last year's, and that is
 * the first row anybody chases.
 */
export default async function Page() {
  const rows = await listOutstandingByCustomer();
  return <OutstandingScreen rows={rows} totals={outstandingTotals(rows)} />;
}
