import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  callerSuggestionsFor,
  deliveryOrdersFor,
  scopedCustomer,
  stockForSku,
} from "@/lib/services/call-context-service";

/**
 * What the call panel is told about the ERP and about earlier callers, loaded
 * when the telecaller picks the reason that needs it — never with the panel,
 * because most calls are about something else.
 *
 * Three kinds, all READ-ONLY:
 *   delivery  — the customer's ERP orders with their transport details
 *   stock     — the ERP's availability for one SKU
 *   callers   — who earlier inbound calls on this account were from
 *
 * Scope is enforced inside the service, which throws for a customer the caller
 * may not see; that answers the same as one that does not exist, or this
 * becomes a way to enumerate the book. A failure of any kind answers with an
 * empty result and a 200: the panel says "could not be read" and the call is
 * still loggable. Logging a call never depends on this route.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "auth" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  const customerId = params.get("customerId");

  try {
    if (kind === "delivery" && customerId) {
      return NextResponse.json({ orders: await deliveryOrdersFor(customerId) });
    }
    if (kind === "callers" && customerId) {
      return NextResponse.json({ suggestions: await callerSuggestionsFor(customerId) });
    }
    if (kind === "stock" && customerId) {
      const skuId = params.get("skuId");
      if (!skuId) return NextResponse.json({ error: "skuId" }, { status: 400 });
      /* Stock is not customer data, but it is only offered mid-call for a
         customer the caller can see — the id is required so the same scope
         check answers it. */
      await scopedCustomer(customerId);
      return NextResponse.json({ stock: await stockForSku(skuId) });
    }
    return NextResponse.json({ error: "kind" }, { status: 400 });
  } catch {
    return NextResponse.json(
      kind === "delivery"
        ? { orders: [], failed: true }
        : kind === "callers"
          ? { suggestions: [], failed: true }
          : { stock: { unavailable: true }, failed: true },
    );
  }
}
