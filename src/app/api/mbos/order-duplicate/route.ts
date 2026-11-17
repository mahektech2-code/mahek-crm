import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/services/mbos-service";
import { scopedCustomer } from "@/lib/actions/mbos";
import { calendarDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { checkForDuplicate, sameOrdersFor, tellSameOrder } from "@/lib/erp/order-hub";
import { db } from "@/db";

/* ---------------------------------------------------------------------------
 * THE DUPLICATE CHECK THE SALESMAN APP ASKS BEFORE IT SENDS A NEW ORDER.
 *
 * Asked only while the phone has signal, and only while the ERP takes the
 * orders: it answers the TO already punched for the same billing and
 * delivery party, the same day and the same items, or null. The phone then
 * asks him. "Same order - don't create" drops his order before anything is
 * sent and posts `{ same: <TO id> }` here, which tells whoever punched the
 * first one; "Different order - create it" sends the order carrying his
 * reason. With no signal none of this is asked: the order goes, and the
 * office marks the TO a possible duplicate for Accounts when it syncs.
 *
 * Scoped like the order itself: the billing party must be in his book. The
 * delivery party is an address on somebody else's order and is not.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const Body = z.object({
  customerId: z.string().trim().min(1),
  deliveryCustomerId: z.string().trim().min(1).nullish(),
  /** When the order is for, epoch ms; now where absent. */
  orderedAt: z.number().nullish(),
  lines: z.array(z.object({ productId: z.string().min(1), quantityCans: z.number().int().positive() })).min(1),
  /** He answered "Same order": the TO it is. */
  same: z.string().trim().min(1).nullish(),
});

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "That could not be read." }, { status: 400 });
  }
  const p = parsed.data;

  /* A shop he may not see answers exactly like one that does not exist. */
  const found = await scopedCustomer(auth.principal, p.customerId);
  if (!found.ok) {
    return NextResponse.json({ ok: false, error: "That shop is not on your book." }, { status: 404 });
  }

  try {
    const config = await getConfig();
    if (config["erp.orders.live"] !== true) return NextResponse.json({ ok: true, found: null });
    const billingId = found.customer.id;
    const deliveryId = p.deliveryCustomerId && p.deliveryCustomerId !== billingId ? p.deliveryCustomerId : billingId;
    const shape = {
      billingId,
      deliveryId,
      date: calendarDate(p.orderedAt ? new Date(p.orderedAt) : new Date()),
      lines: p.lines.map((l) => ({ skuId: l.productId, qtyCans: l.quantityCans })),
    };
    if (p.same) {
      /* Only a TO that really is this order: a crafted id cannot ring anybody. */
      const matches = await sameOrdersFor(db, shape);
      if (!matches.some((m) => m.id === p.same)) {
        return NextResponse.json({ ok: false, error: "That order has changed. Check again before you decide." }, { status: 409 });
      }
      await tellSameOrder(p.same, auth.principal.user.id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: true, found: await checkForDuplicate(shape) });
  } catch (e) {
    console.error("Order duplicate check failed:", e instanceof Error ? e.message : e);
    /* A check that cannot answer never stops an order: the phone sends it, and
       the office checks again when it syncs. */
    return NextResponse.json({ ok: false, error: "The duplicate check could not be asked just now. The order is checked when it syncs." }, { status: 500 });
  }
}
