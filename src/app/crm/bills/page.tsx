import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { getCustomer } from "@/lib/queries";
import {
  agingSummary,
  earliestBillDate,
  listBills,
} from "@/lib/services/payment-service";
import { today } from "@/lib/queries";
import { getConfig } from "@/lib/config/store";
import { financialYearOf, financialYearsBetween } from "@/lib/financial-year";
import { BillsScreen } from "./bills-screen";

export const metadata = { title: "Sales bills - MahekOne CRM" };

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; fy?: string }>;
}) {
  const { customer: customerId, fy } = await searchParams;
  const user = await requireUser();
  const scope = await getScope(user);

  // The ledger is ten thousand bills across three years. A year is the cut a
  // person actually works in — Mahek's own bill numbers carry it — so the
  // current one is the default and the rest are a select away, rather than
  // every bill ever raised arriving at the browser to be paged there.
  const [day, earliest, config] = await Promise.all([
    today(),
    earliestBillDate(),
    getConfig(),
  ]);
  const years = financialYearsBetween(earliest, day);
  const financialYear = fy && years.includes(fy) ? fy : financialYearOf(day);

  const [rows, customer] = await Promise.all([
    listBills({ financialYear }),
    customerId ? getCustomer(customerId) : null,
  ]);
  // Summed from the rows above rather than read again, so the strip cannot
  // describe a different year to the table beneath it.
  const aging = agingSummary(rows);

  return (
    <BillsScreen
      modes={config["payments.modes"]}
      datedModes={config["payments.datedModes"]}
      today={day}
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      rows={rows}
      aging={aging}
      customerFilter={customer ? { id: customer.id, name: customer.name } : null}
      financialYear={financialYear}
      financialYears={years}
    />
  );
}
