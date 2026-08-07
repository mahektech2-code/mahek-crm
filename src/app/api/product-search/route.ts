import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { searchProducts } from "@/lib/services/product-service";

/**
 * §2.2 — catalogue search, called while a telecaller is mid-call, so it has
 * to answer inside a keystroke. The switch that turns it off is checked here
 * as well as in the interface: a hidden box is not a disabled feature.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ products: [] }, { status: 401 });

  const config = await getConfig();
  if (!config["products.searchOnOrderForms"]) {
    return NextResponse.json({ products: [] });
  }

  const params = new URL(request.url).searchParams;
  const query = params.get("q") ?? "";
  const customerId = params.get("customerId") ?? undefined;

  try {
    return NextResponse.json({
      products: await searchProducts(query, customerId),
    });
  } catch {
    // A failed search must not take the order form down with it.
    return NextResponse.json({ products: [] }, { status: 200 });
  }
}
