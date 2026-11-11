import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { APP_TIMEZONE } from "@/lib/business-date";
import { hatForHeader } from "@/lib/hat-for-header";
import { today } from "@/lib/recompute";
import { incomingTransfers, myTasks } from "@/lib/tasks/service";
import { TaskDialogs } from "./_ui/dialogs";
import { MyDayScreen } from "./_ui/screens";

export const metadata = { title: "My day" };

/** My day: what is late, what is due today, the next three days, and what was done today — in every app. */
export default async function MyDayPage() {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [tasks, incoming, day, hat] = await Promise.all([myTasks(user.id), incomingTransfers(user.id), today(), hatForHeader(user, "tasks")]);
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, hour: "numeric", hour12: false }).format(now));
  const dateLine = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(now);
  return (
    <TaskDialogs>
      <MyDayScreen
        tasks={tasks}
        incoming={incoming}
        today={day}
        viewerId={user.id}
        greeting={`${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${user.name.split(" ")[0]}`}
        dateLine={`${dateLine} · ${hat.label}`}
      />
    </TaskDialogs>
  );
}
