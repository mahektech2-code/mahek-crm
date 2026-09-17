/*
 * A ROUTE, and the screen is somewhere else.
 *
 * The Lead Management workspace is mounted by both the Manager Console and the
 * CRM from one set of files — see `lib/lead-workspace.ts`. What belongs to an
 * app is which workspace it is, which module key guards it, and what the tab
 * says; everything else would be a second copy drifting from the first.
 */
import { Body } from "@/components/leads/pages/leads-board";

export const metadata = { title: "Stage board — Sales Dashboard — MahekOne" };

export default async function Page(
  props: Omit<React.ComponentProps<typeof Body>, "workspace">,
) {
  return <Body workspace="sales" {...props} />;
}
