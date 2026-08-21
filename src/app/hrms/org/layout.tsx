import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for the Org Chart.
 *
 * The HRMS layout above has already refused anybody without the app — salaries
 * and home addresses live in here — and this narrows it to the people given
 * this screen. One check, not two roles: editing the chart is gated on HRMS
 * access itself, because anybody holding that grant already sees far more
 * sensitive things than a reporting line.
 */
export default async function OrgModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "hrms.org");
  return children;
}
