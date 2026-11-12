import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { isTaskApp } from "@/lib/tasks/rules";
import { openByApp } from "@/lib/tasks/service";
import { boardColumns } from "@/lib/tasks/list-service";
import { TaskDialogs } from "../_ui/dialogs";
import { BoardScreen } from "../_ui/screens";

export const metadata = { title: "Board" };

export default async function BoardPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [{ app: a }, day] = await Promise.all([searchParams, today()]);
  const app = a && isTaskApp(a) ? a : null;
  const [cols, apps] = await Promise.all([boardColumns(user.id, day, app), openByApp(user.id, day)]);
  return (
    <TaskDialogs defaultApp={app ?? undefined}>
      <BoardScreen cols={cols} apps={apps} app={app} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
