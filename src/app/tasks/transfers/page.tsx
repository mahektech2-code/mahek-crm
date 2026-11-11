import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { incomingTransfers, outgoingTransfers, transferHistory } from "@/lib/tasks/service";
import { TaskDialogs } from "../_ui/dialogs";
import { TransfersScreen } from "../_ui/screens";

export const metadata = { title: "Transfers" };

export default async function TransfersPage() {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [incoming, outgoing, history, day] = await Promise.all([incomingTransfers(user.id), outgoingTransfers(user.id), transferHistory(user.id), today()]);
  return (
    <TaskDialogs>
      <TransfersScreen incoming={incoming} outgoing={outgoing} history={history} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
