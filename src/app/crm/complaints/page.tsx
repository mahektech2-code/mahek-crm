import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { complaintEventsFor, listComplaints } from "@/lib/queries";
import { ComplaintsScreen } from "./complaints-screen";

export const metadata = { title: "Complaints — MahekOne CRM" };

export default async function ComplaintsPage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const rows = await listComplaints(user, scope);

  const events = await complaintEventsFor(rows.map((c) => c.id));

  return (
    <ComplaintsScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      isTeamView={scope === "team" && isManager(user)}
      rows={rows}
      events={events}
    />
  );
}
