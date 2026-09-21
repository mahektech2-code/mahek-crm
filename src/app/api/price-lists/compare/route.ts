import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { compareLists } from "@/lib/services/price-list-service";

/**
 * Two lists side by side, per SKU.
 *
 * Fetched when a manager picks the other list rather than carried on the page:
 * the comparison is a few hundred rows and most lists are never compared.
 */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const params = new URL(request.url).searchParams;
  const a = params.get("a");
  const b = params.get("b");
  if (!a || !b) return NextResponse.json({ error: "Two lists are needed." }, { status: 400 });

  const comparison = await compareLists(a, b);
  if (!comparison) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(comparison);
}
