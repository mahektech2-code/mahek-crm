import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { listOpportunities } from "@/lib/services/opportunity-service";
import { OpportunitiesScreen } from "./opportunities-screen";

export const metadata = { title: "Opportunities - MahekOne CRM" };

export default async function OpportunitiesPage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const rows = await listOpportunities();

  return (
    <OpportunitiesScreen
      scopeLabel={scopeLabel(scope, user)}
      isTeamView={scope === "team" && isManager(user)}
      userId={user.id}
      rows={rows}
    />
  );
}
