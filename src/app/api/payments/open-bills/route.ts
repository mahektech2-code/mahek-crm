import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { onAccountBalance, openBillsFor } from "@/lib/services/receipt-service";

/**
 * What is open on one account, loaded when a customer is picked rather than
 * with the search — a search returns twelve customers and needs none of it.
 *
 * Scope is enforced inside `openBillsFor`, which throws for a customer the
 * caller may not see; that answers the same as a customer who does not exist,
 * or the endpoint becomes a way to enumerate the book.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ bills: [] }, { status: 401 });

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ bills: [] }, { status: 400 });

  try {
    const [bills, onAccount] = await Promise.all([
      openBillsFor(customerId),
      onAccountBalance(customerId),
    ]);
    return NextResponse.json({ bills, onAccount });
  } catch {
    return NextResponse.json({ bills: [], onAccount: 0 }, { status: 403 });
  }
}
