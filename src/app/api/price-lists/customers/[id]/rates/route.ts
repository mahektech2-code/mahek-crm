import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { ratesForCustomer } from "@/lib/services/price-list-service";
import { today } from "@/lib/recompute";

/**
 * WHAT THIS SHOP PAYS FOR THESE PRODUCTS, for an order form that is being
 * typed into.
 *
 * A route rather than a prop, because the products on the form change as the
 * telecaller searches and re-rendering the page for each one would lose what
 * they had typed. The business day is read on the SERVER: a rate is resolved
 * as of a date and a browser's idea of today is its own.
 */
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const products = (new URL(request.url).searchParams.get("products") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!products.length) return NextResponse.json({});

  return NextResponse.json(await ratesForCustomer(id, products, await today()));
}
