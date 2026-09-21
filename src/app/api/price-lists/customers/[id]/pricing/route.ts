import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkCapability } from "@/lib/access-control";
import { customerPricing } from "@/lib/services/price-list-service";
import { today } from "@/lib/recompute";

/**
 * One shop's whole pricing picture: the list, the chain of reasons behind it,
 * the rates and anything asked for on top.
 *
 * Read by the "which list applies?" preview, where a manager types a shop's
 * name and expects the answer without leaving the screen they are on.
 * `customerPricing` asserts the caller may see the customer at all, so a
 * refusal here is the customer's own scope answering.
 */
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { allowed } = await checkCapability("pricelist.read");
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const pricing = await customerPricing(id, await today());
    if (!pricing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(pricing);
  } catch {
    // Out of scope and does not exist answer alike, or this endpoint becomes
    // a way to find out which customers there are.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
