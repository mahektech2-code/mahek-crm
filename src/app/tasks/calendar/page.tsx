import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { today } from "@/lib/recompute";
import { calendarWeek } from "@/lib/tasks/list-service";
import { plusDays } from "@/lib/tasks/rules";
import { TaskDialogs } from "../_ui/dialogs";
import { CalendarScreen } from "../_ui/screens-more";

export const metadata = { title: "Calendar" };

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const words = (d: string) => `${Number(d.slice(8, 10))} ${MO[Number(d.slice(5, 7)) - 1]}`;

/** A week, Monday to Sunday, of this person's tasks in every app; what is late sits on today. Each day is capped, and says how many more. */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "tasks.my-work");
  const [{ week: w }, day] = await Promise.all([searchParams, today()]);
  const week = Math.max(-52, Math.min(52, Number.parseInt(w ?? "0", 10) || 0));
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  const monday = plusDays(day, -((wd + 6) % 7) + week * 7);
  const days = Array.from({ length: 7 }, (_, i) => plusDays(monday, i));
  const data = await calendarWeek(user.id, days, day);
  return (
    <TaskDialogs>
      <CalendarScreen data={data} days={days} today={day} week={week} rangeWords={`${words(days[0])} – ${words(days[6])} ${days[6].slice(0, 4)}`} />
    </TaskDialogs>
  );
}
