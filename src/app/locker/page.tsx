import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { PageHead } from "./_ui/kit";

export const metadata = { title: "Dashboard" };

export default async function LockerDashboard() {
  const user = await requireUser();
  await requireModule(user.id, "locker.dashboard");
  return <PageHead crumb="Locker · Overview" title="Dashboard" sub="What needs attention, most serious first." />;
}
