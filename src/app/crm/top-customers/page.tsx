import { redirect } from "next/navigation";

/**
 * Top customers moved onto Monthly targets, as its second tab. The address it
 * shipped at is kept so a bookmark lands on it rather than on a 404.
 */
export default function TopCustomersMoved() {
  redirect("/crm/targets?view=top");
}
