import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { today } from "@/lib/recompute";
import { TASK_APP_LABEL } from "@/lib/tasks/rules";
import { incomingTransfers, myTasks } from "@/lib/tasks/service";
import { TaskDialogs } from "@/app/tasks/_ui/dialogs";
import { CrmTasksScreen } from "@/app/tasks/_ui/screens";

export const metadata = { title: "My tasks - MahekOne CRM" };

/**
 * TeleCRM's own My tasks: the same rows as the Tasks app, narrowed to the ones
 * whose work happens in the CRM (and personal ones). What is waiting in other
 * apps is counted and named, so nothing is invisible from here.
 */
export default async function CrmTasksPage() {
  const user = await requireUser();
  const [all, incoming, day, apps] = await Promise.all([myTasks(user.id), incomingTransfers(user.id), today(), listUserApps(user.id)]);
  const here = all.filter((t) => t.app === "crm" || t.app === "tasks");
  const elsewhere = all.filter((t) => t.status !== "done" && t.app !== "crm" && t.app !== "tasks");
  return (
    <div className="max-w-[1200px] px-6 pt-6 pb-10">
      <TaskDialogs defaultApp="crm">
        <CrmTasksScreen
          tasks={here}
          incoming={incoming.filter((t) => t.app === "crm" || t.app === "tasks")}
          elsewhere={{ count: elsewhere.length, apps: [...new Set(elsewhere.map((t) => TASK_APP_LABEL[t.app]))] }}
          today={day}
          viewerId={user.id}
          hasTasksApp={apps.includes("tasks")}
        />
      </TaskDialogs>
    </div>
  );
}
