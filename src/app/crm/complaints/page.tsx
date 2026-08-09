import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { complaintHistories, listComplaints } from "@/lib/services/worklist-services";
import { getConfig } from "@/lib/config/store";
import { ComplaintsScreen } from "./complaints-screen";

export const metadata = { title: "Complaints - MahekOne CRM" };

export default async function ComplaintsPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, config] = await Promise.all([listComplaints(), getConfig()]);
  const events = await complaintHistories(rows.map((c) => c.id));

  return (
    <ComplaintsScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      isTeamView={scope === "team" && isManager(user)}
      rows={rows}
      events={events}
      // Categories are configuration, not a constant — a manager edits the
      // list in the Admin Console without a deploy.
      categories={config["complaints.categories"]}
      maxImages={config["attachments.maxPerComplaint"]}
    />
  );
}
