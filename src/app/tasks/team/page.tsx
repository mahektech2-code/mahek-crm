import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { teamPeople, teamTasks } from "@/lib/tasks/service";
import { TaskDialogs } from "../_ui/dialogs";
import { TeamScreen } from "../_ui/screens";

export const metadata = { title: "Team workload" };

/** Everybody below this person on the org chart, and every task they have. Empty for somebody nobody reports to. */
export default async function TeamPage({ searchParams }: { searchParams: Promise<{ person?: string }> }) {
  const user = await requireUser();
  const [{ person }, people, tasks, day] = await Promise.all([searchParams, teamPeople(user), teamTasks(user), today()]);
  return (
    <TaskDialogs>
      <TeamScreen tasks={tasks} people={people} today={day} viewerId={user.id} person={person && people.some((p) => p.id === person) ? person : null} />
    </TaskDialogs>
  );
}
