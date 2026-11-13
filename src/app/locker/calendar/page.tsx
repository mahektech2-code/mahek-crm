import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { toLite } from "@/lib/locker/register-service";
import { registerFor, today } from "@/lib/locker/service";
import { CalendarScreen } from "./calendar-screen";

export const metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.calendar");
  const day = today();
  const [access, rows] = await Promise.all([lockerAccess(user.id), registerFor(user.id, day)]);
  return <CalendarScreen rows={rows.filter((a) => a.live && a.endDate).map(toLite)} today={day} cats={access.categories} />;
}
