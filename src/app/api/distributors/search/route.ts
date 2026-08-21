import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { can } from "@/lib/access-control";
import { distributorCandidates } from "@/lib/services/distributor-service";

/**
 * The accounts that may be named as who bills a shop.
 *
 * Typed a character at a time in a dialog somebody is half way through, so a
 * failure answers with an empty list and a 200 rather than taking the dialog
 * down — the same shape as the payment search box next door.
 *
 * `customer.classify` is checked HERE as well as in the action. This endpoint
 * answers "which of our accounts are direct customers", which is not a
 * question to hand to anybody who can guess a URL, and a route left open
 * because the button that calls it is hidden is not a closed route.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ hits: [] }, { status: 401 });
  if (!can(user.role, "customer.classify")) {
    return NextResponse.json({ hits: [] }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const exclude = params.get("exclude") ?? undefined;
  try {
    // `hits` and `more` both, because a capped list that does not say so reads
    // as the whole answer — and somebody who cannot see their distributor in it
    // concludes we do not hold the account.
    return NextResponse.json(await distributorCandidates(q, { excludeCustomerId: exclude }));
  } catch {
    return NextResponse.json({ hits: [], more: 0, mode: "wide" });
  }
}
