import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { listCustomers } from "@/lib/queries";
import { listReminders } from "@/lib/services/worklist-services";
import { RemindersScreen } from "./reminders-screen";

export const metadata = { title: "Reminders - MahekOne CRM" };

export default async function RemindersPage() {
  const user = await requireUser();
  const scope = await getScope(user);

  const [rows, customers] = await Promise.all([listReminders(), listCustomers()]);

  return (
    <RemindersScreen
      scopeLabel={scopeLabel(scope, user)}
      isTeamView={scope === "team" && isManager(user)}
      rows={rows}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
