import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { opensTheBook } from "@/app/api/book-door";
import { paymentSearch } from "@/lib/services/receipt-service";

/**
 * One box over every way a payment names its customer — the customer, a bill
 * number, an order number, a UTR. Typed a character at a time while somebody
 * is on the phone, so a failure answers with an empty list and a 200 rather
 * than taking the form down with it.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ hits: [] }, { status: 401 });

  /* A screen this belongs to, first — see `book-door.ts`. */
  if (!(await opensTheBook(user.id))) {
    return NextResponse.json({ hits: [] }, { status: 403 });
  }

  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    return NextResponse.json({ hits: await paymentSearch(q) });
  } catch {
    return NextResponse.json({ hits: [] });
  }
}
