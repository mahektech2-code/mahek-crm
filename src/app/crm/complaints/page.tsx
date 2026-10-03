import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { getScope, scopeLabel, managesHere } from "@/lib/scope";
import {
  complaintAttachments,
  complaintHistories,
  listComplaints,
} from "@/lib/services/worklist-services";
import { getConfig } from "@/lib/config/store";
import { ComplaintsScreen } from "./complaints-screen";

export const metadata = { title: "Complaints - MahekOne CRM" };

export default async function ComplaintsPage() {
  const user = await requireUser();
  /* A manager OF THE CRM — `isManager` was the widest level held in any app. */
  const managerHere = await managesHere(user, "crm");
  const scope = await getScope(user);

  const [rows, config] = await Promise.all([listComplaints(), getConfig()]);
  const ids = rows.map((c) => c.id);
  const [events, attachments] = await Promise.all([
    complaintHistories(ids),
    complaintAttachments(ids),
  ]);

  return (
    <ComplaintsScreen
      scopeLabel={scopeLabel(scope, user)}
      canResolve={await canFor(user, "complaint.resolve")}
      isTeamView={scope === "team" && managerHere}
      rows={rows}
      events={events}
      attachments={attachments}
      // Categories are configuration, not a constant — a manager edits the
      // list in the Admin Console without a deploy.
      categories={config["complaints.categories"]}
      maxImages={config["attachments.maxPerComplaint"]}
    />
  );
}
