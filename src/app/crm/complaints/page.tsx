import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { complaintEventsFor, listBills, listComplaints } from "@/lib/queries";
import { ComplaintsScreen } from "./complaints-screen";

export const metadata = { title: "Complaints — MahekOne CRM" };

export default async function ComplaintsPage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const [rows, bills] = await Promise.all([
    listComplaints(user, scope),
    listBills(user, scope),
  ]);

  const events = await complaintEventsFor(rows.map((c) => c.id));

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
    />
  );
}
