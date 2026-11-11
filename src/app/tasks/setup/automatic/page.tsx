import { requireUser } from "@/lib/auth";
import { AUTOMATIONS } from "@/lib/tasks/automations";
import { automationOpenCounts, automationStates } from "@/lib/tasks/automation-service";
import { canManageAutomations } from "@/lib/tasks/setup-access";
import { AutomaticScreen } from "../../_ui/screens-more";

export const metadata = { title: "Automatic tasks" };

/** Every rule that raises tasks on its own, app by app. Read by anybody with Set up; switched only by a Tasks administrator. */
export default async function AutomaticPage() {
  const user = await requireUser();
  const [states, counts, canManage] = await Promise.all([automationStates(), automationOpenCounts(), canManageAutomations(user)]);
  return <AutomaticScreen rules={AUTOMATIONS} states={Object.fromEntries(states)} counts={Object.fromEntries(counts)} canManage={canManage} />;
}
