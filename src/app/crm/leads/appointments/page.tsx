/*
 * A ROUTE, and the screen is somewhere else.
 *
 * The Lead Management workspace is mounted by both the Manager Console and the
 * CRM from one set of files — see `lib/lead-workspace.ts`. What belongs to an
 * app is which workspace it is, which module key guards it, and what the tab
 * says; everything else would be a second copy drifting from the first.
 */
import { Body } from "@/components/leads/pages/leads-appointments";

export const metadata = { title: "Distributor appointments — CRM — MahekOne" };

export default async function Page() {
  return <Body workspace="crm" />;
}
