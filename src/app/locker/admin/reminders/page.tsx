import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { reminderLadders } from "@/lib/locker/service";
import { PageHead } from "../../_ui/kit";
import { LaddersScreen } from "./ladders-screen";

export const metadata = { title: "Reminders" };

export default async function RemindersPage() {
  const user = await requireUser();
  await requireModule(user.id, "locker.ladders");
  const ladders = await reminderLadders();
  return (
    <>
      <PageHead crumb="Locker · Admin" title="Reminder schedules" sub="When reminders fire and who they reach, by importance. Days are counted to the day somebody must act — the notice deadline for a contract. A reminder due on a Sunday fires on the Saturday before." />
      <LaddersScreen ladders={ladders} />
    </>
  );
}
