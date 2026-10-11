import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { opensTheBook } from "@/app/api/book-door";
import { customerStatement } from "@/lib/services/customer-statement-service";

/**
 * One customer's statement for a period, for the CRM customer record's Ledger
 * tab — the same `customerStatement` Accounts → Customer account renders, so
 * the two apps quote one account one way.
 *
 * Scope is enforced inside the ledger read, which throws for a customer the
 * caller may not see; that answers exactly as a customer who does not exist,
 * or the endpoint becomes a way to enumerate the book.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  /* A screen this belongs to, first — see `book-door.ts`. */
  if (!(await opensTheBook(user.id))) {
    return NextResponse.json({ error: "Not available." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const customerId = params.get("customer");
  if (!customerId) return NextResponse.json({ error: "No customer." }, { status: 400 });

  try {
    const statement = await customerStatement(customerId, {
      year: params.get("year") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    });
    if (!statement.ledger) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({
      ...statement,
      canReverse: await canFor(user, "payment.confirm"),
    });
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
}
