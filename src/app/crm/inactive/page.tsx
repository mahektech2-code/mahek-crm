import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { listInactiveWatch } from "@/lib/services/worklist-services";
import { InactiveScreen } from "./inactive-screen";

export const metadata = { title: "Inactive watch - MahekOne CRM" };

export default async function InactivePage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const rows = await listInactiveWatch();

  return (
    <InactiveScreen
      scopeLabel={scopeLabel(scope, user)}
      isManager={isManager(user)}
      rows={rows}
    />
  );
}
