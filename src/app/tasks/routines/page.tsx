import { requireUser } from "@/lib/auth";
import { listUserApps, requireModule } from "@/lib/access";
import { isTaskApp } from "@/lib/tasks/rules";
import { routinesFor } from "@/lib/tasks/routine-service";
import { teamPeople } from "@/lib/tasks/service";
import { RoutinesScreen } from "../_ui/routines";

export const metadata = { title: "Routines" };

/**
 * A person's routines and, for somebody with people under them, their team's.
 * Part of "my work" rather than a module of its own: a routine is where a
 * person's daily tasks come from, so whoever holds My day must be able to see
 * why a task is on it.
 */
export default async function RoutinesPage() {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [routines, team, held] = await Promise.all([routinesFor(user), teamPeople(user), listUserApps(user.id)]);
  const apps = ["tasks", ...held.filter((a) => isTaskApp(a) && a !== "tasks")];
  return (
    <RoutinesScreen
      routines={routines}
      people={[{ id: user.id, name: user.name, apps: held as string[] }, ...team]}
      apps={apps}
      viewerId={user.id}
    />
  );
}
