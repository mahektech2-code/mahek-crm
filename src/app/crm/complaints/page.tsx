import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { complaintHistories, listComplaints } from "@/lib/services/worklist-services";
import { listBills } from "@/lib/services/payment-service";
import { getConfig } from "@/lib/config/store";
import { ComplaintsScreen } from "./complaints-screen";

export const metadata = { title: "Complaints - MahekOne CRM" };

export default async function ComplaintsPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, bills, config] = await Promise.all([
    listComplaints(),
    listBills(),
    getConfig(),
  ]);
  const events = await complaintHistories(rows.map((c) => c.id));

  // The Request CN flow needs the customer's bills to hand, so the dialog can
  // offer them the moment a customer is picked rather than on another trip.
  const billsByCustomer = new Map<
    string,
    Array<{ id: string; billNo: string; billDate: string }>
  >();
  for (const b of bills) {
    const list = billsByCustomer.get(b.customerId) ?? [];
    list.push({ id: b.id, billNo: b.billNo, billDate: b.billDate });
    billsByCustomer.set(b.customerId, list);
  }

  return (
    <ComplaintsScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      isTeamView={scope === "team" && isManager(user)}
      rows={rows}
      events={events}
      billsByCustomer={Object.fromEntries(billsByCustomer)}
      loggedInUserName={user.name}
      // Categories are configuration, not a constant — a manager edits the
      // list at /crm/settings without a deploy.
      categories={config["complaints.categories"]}
    />
  );
}
