import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { getBillDetail } from "@/lib/services/bill-detail-service";

/**
 * Everything behind one bill — its order, the items on it, and the receipts
 * against it — loaded when the row is opened rather than with the ledger. Ten
 * thousand bills' worth of line items is not something to send to a browser
 * that will show one.
 *
 * Scope is applied inside `getBillDetail`, so a bill the caller may not see
 * answers exactly as one that does not exist.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ detail: null }, { status: 401 });

  /*
   * THREE LEDGERS OPEN THIS NOW. The CRM's, the Accounts bill list, and the
   * Sales Dashboard's Invoices screen — a bookmarked endpoint must be gated
   * the same way its screens are, not just hidden from a menu.
   *
   * Widening the list does not widen what comes back: `getBillDetail` resolves
   * the caller's own scope and a bill outside it answers exactly as one that
   * does not exist. What this decides is only whether somebody has a screen
   * this belongs to at all.
   */
  const apps = await listUserApps(user.id);
  if (!apps.some((a) => a === "crm" || a === "accounts" || a === "sales")) {
    return NextResponse.json({ detail: null }, { status: 403 });
  }

  const billId = new URL(request.url).searchParams.get("billId");
  if (!billId) return NextResponse.json({ detail: null }, { status: 400 });

  const detail = await getBillDetail(billId);
  if (!detail) return NextResponse.json({ detail: null }, { status: 404 });

  return NextResponse.json({ detail });
}
