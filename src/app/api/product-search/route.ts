import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { listActiveProducts, searchProducts } from "@/lib/services/product-service";

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
    /* `?all=1` is the whole active catalogue, for the lead-intake picker that
       offers every product and narrows as somebody types. Behind the same login
       and the same switch as the search. */
    if (params.get("all") === "1") {
      return NextResponse.json({ products: await listActiveProducts() });
    }
    return NextResponse.json({
      products: await searchProducts(query, customerId),
    });
  } catch {
    // A failed search must not take the order form down with it.
    return NextResponse.json({ products: [] }, { status: 200 });
  }
}
