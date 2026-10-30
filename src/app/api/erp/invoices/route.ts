import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { invoicePack, orderNosOf } from "@/lib/erp/invoice-print";
import { invoiceCopies } from "@/lib/erp/trace-links";

/**
 * GET ?orders=10082,10080 — the orders' Tally invoices as one PDF, for the
 * ERP's own viewer and printing. Each file is read through `canRead`, so it
 * opens for exactly the people who may open Orders.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });
  const url = new URL(request.url);
  const orders = orderNosOf(url.searchParams.get("orders"));
  if (!orders.length) return new NextResponse("No orders named", { status: 400 });
  const pack = await invoicePack(orders, invoiceCopies(url.searchParams.get("copies")));
  if (!pack) return new NextResponse("No invoice PDF on these orders", { status: 404 });
  const name = pack.orders.length === 1 ? `invoice-${pack.orders[0]}.pdf` : `invoices-${pack.orders.length}.pdf`;
  return new NextResponse(Buffer.from(pack.pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Invoice-Missing": pack.missing.join(","),
    },
  });
}
