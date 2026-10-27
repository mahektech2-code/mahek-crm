/*
 * THE SALES MANAGER'S OWN ROUTE TO THE QUALIFICATION REVIEW.
 *
 * The Sales Manager works in this tree, behind `crm.sales-manager`. The record
 * the review normally hangs from (`/crm/leads/[id]/…`) is behind `crm.leads`,
 * which a Sales Manager seat does not necessarily hold — so a link into it from
 * here could send them to a page they are turned away from. It is the same
 * screen and the same actions; only the way in, and where Close goes back to,
 * differ.
 */
import { Body } from "@/components/leads/pages/leads-record-review";

export const metadata = { title: "Qualification review — Sales Manager — CRM — MahekOne" };

export default async function Page(
  props: Omit<React.ComponentProps<typeof Body>, "workspace" | "closeBase">,
) {
  return <Body workspace="crm" closeBase="/crm/leads/sales-manager" {...props} />;
}
