import { redirect } from "next/navigation";
import { erpLink } from "@/lib/erp/registry";

/**
 * The old print sheet. Invoices now open and print in a pop-up on the list
 * (the view and print buttons, or Print invoices on a selection), so a link
 * to this page lands on Billing & dispatch instead.
 */
export default function PrintInvoices() {
  redirect(erpLink("orderDetails", {}));
}
