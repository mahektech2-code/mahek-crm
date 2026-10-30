import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { orderNosOf } from "@/lib/erp/invoice-print";
import { invoiceFilesFor } from "@/lib/erp/order-tracking";
import { invoiceCopies } from "@/lib/erp/trace-links";
import { Page } from "../_ui/page-head";
import { InvoicePrinter } from "./printer";

/**
 * ?orders=10082,10080 — the orders' Tally invoices, joined into one PDF to
 * print or download. One copy each unless the person asks for more. Opened
 * from an order's print button, the record's Invoice tab, or Print invoices
 * over a selection. Everybody who holds Orders may print.
 */
export const dynamic = "force-dynamic";

export default async function PrintInvoices({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("orders")) redirect("/erp");
  const sp = await searchParams;
  const orders = orderNosOf(typeof sp.orders === "string" ? sp.orders : "");
  const files = await invoiceFilesFor(orders);
  const withPdf = orders.filter((n) => files.has(n));
  const missing = orders.filter((n) => !files.has(n));
  return (
    <Page title={orders.length === 1 ? `Invoice · order ${orders[0]}` : `Invoices · ${orders.length} orders`}>
      <InvoicePrinter orders={withPdf} missing={missing} copies={invoiceCopies(sp.copies)} />
    </Page>
  );
}
