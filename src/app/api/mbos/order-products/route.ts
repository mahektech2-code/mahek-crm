import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/services/mbos-service";
import { scopedCustomer } from "@/lib/actions/mbos";
import { customerProducts, popularProducts } from "@/lib/services/product-service";
import { getConfig } from "@/lib/config/store";

/* ---------------------------------------------------------------------------
 * WHAT TO OFFER ON THE HANDSET'S ORDER FORM — this shop's usual products, and
 * the best sellers to start a new shop from.
 *
 * The handset could not answer either. Its copy of a shop's past orders holds
 * how many lines each had and not which products, so "usual" counted only
 * orders placed on that same phone — nearly always none — and the starter list
 * was the first eight SKUs alphabetically, which is eight pack sizes of one
 * thinner, offered at every counter in the book. The office has the answer
 * already: `customerProducts` and `popularProducts` are what the CRM's order
 * form reads, over the eleven thousand orders the sheet has written, so this
 * asks them rather than restating them. One aggregation answers "what do they
 * buy" — AGENTS.md — and a second copy on a phone would be the one that drifts.
 *
 * A REQUEST rather than a pull channel because it is a SUGGESTION: the order is
 * typed and saved with no signal either way, and the phone keeps the last
 * answer per shop so a counter it has served before is offered the same list
 * offline. Product ids only — the catalogue itself already lives on the phone.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const Body = z.object({ customerId: z.string().trim().min(1) });

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "That could not be read." }, { status: 400 });
  }

  /* A shop he may not see answers exactly like one that does not exist. */
  const found = await scopedCustomer(auth.principal, parsed.data.customerId);
  if (!found.ok) {
    return NextResponse.json({ ok: false, error: "That shop is not on your book." }, { status: 404 });
  }

  try {
    const config = await getConfig();
    const [usual, starter] = await Promise.all([
      customerProducts(found.customer.id, { limit: config["products.frequentCount"] }),
      popularProducts(),
    ]);
    return NextResponse.json({
      ok: true,
      usual: usual.map((p) => ({
        productId: p.productId,
        orderCount: p.totalOrderCount,
        lastPurchaseDate: p.lastPurchaseDate,
      })),
      starter: starter.map((p) => p.productId),
    });
  } catch (e) {
    console.error("Order products failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: "The usual products could not be read just now. Search instead — nothing is lost." },
      { status: 500 },
    );
  }
}
