import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { tasksBetween } from "@/lib/tasks/service";
import { plusDays } from "@/lib/tasks/rules";
import { TaskDialogs } from "../_ui/dialogs";
import { CalendarScreen } from "../_ui/screens-more";

export const metadata = { title: "Calendar" };

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const words = (d: string) => `${Number(d.slice(8, 10))} ${MO[Number(d.slice(5, 7)) - 1]}`;

/** A week, Monday to Sunday, of this person's tasks in every app; what is late sits on today. */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [{ week: w }, day] = await Promise.all([searchParams, today()]);
  const week = Math.max(-52, Math.min(52, Number.parseInt(w ?? "0", 10) || 0));
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  const monday = plusDays(day, -((wd + 6) % 7) + week * 7);
  const days = Array.from({ length: 7 }, (_, i) => plusDays(monday, i));
  const tasks = await tasksBetween(user.id, days[0], days[6]);
  return (
    <TaskDialogs>
      <CalendarScreen tasks={tasks} days={days} today={day} week={week} rangeWords={`${words(days[0])} – ${words(days[6])} ${days[6].slice(0, 4)}`} />
    </TaskDialogs>
  );
}
