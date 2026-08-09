import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { getCustomer } from "@/lib/queries";
import {
  agingSummary,
  earliestBillDate,
  listBills,
} from "@/lib/services/payment-service";
import { today } from "@/lib/queries";
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
  const [day, earliest] = await Promise.all([today(), earliestBillDate()]);
  const years = financialYearsBetween(earliest, day);
  const financialYear = fy && years.includes(fy) ? fy : financialYearOf(day);

  const [rows, aging, customer] = await Promise.all([
    listBills({ financialYear }),
    // The same filter, so the aging strip describes the table beneath it.
    agingSummary({ financialYear }),
    customerId ? getCustomer(customerId) : null,
  ]);

  return (
    <BillsScreen
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
