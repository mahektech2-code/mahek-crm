/*
 * A ROUTE, and the screen is somewhere else — see `lib/lead-workspace.ts`.
 */
import { Body } from "@/components/leads/pages/leads-record-review";

export const metadata = { title: "Qualification review — Lead — MahekOne" };

export default async function Page(
  props: Omit<React.ComponentProps<typeof Body>, "workspace">,
) {
  return <Body workspace="crm" {...props} />;
}
