import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { customerTimeline } from "@/lib/queries";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { NotPermittedError, assertCustomerInScope } from "@/lib/access-control";

/**
 * The last few interactions for the call panel. Fetched when the panel opens
 * rather than prefetched for every queue row — prefetching cost one round trip
 * per customer for panels that mostly never get opened.
 */
const HISTORY_SHOWN = 3;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ history: [] }, { status: 401 });

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ history: [] }, { status: 400 });

  /*
   * THE SAME CHECK THE RECORD MAKES, before a single row is read.
   *
   * This route took any customer id from the query string and answered with
   * their history — so anybody signed in could read the calls on a customer
   * outside their book by changing one parameter. `loadCustomerTimeline` in
   * `actions/crm.ts` is the paging door onto the same timeline and has always
   * asked `assertCustomerInScope` first; this is its other door and now asks
   * the same thing. Out of scope, gone, or trashed all answer exactly like a
   * customer with no history, so the route is not a way to learn which ids
   * exist.
   */
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  if (!customer) return NextResponse.json({ history: [] });
  try {
    await assertCustomerInScope(customer);
  } catch (e) {
    if (e instanceof NotPermittedError) return NextResponse.json({ history: [] });
    throw e;
  }

  // Three, asked for as three. This read the customer's whole history and then
  // threw all but the first three rows away in JavaScript — on a path that runs
  // every time a telecaller opens the call panel.
  const timeline = await customerTimeline(customerId, { limit: HISTORY_SHOWN });
  return NextResponse.json({
    history: timeline.entries.map((t) => ({
      kind: t.kind,
      at: t.at.toISOString(),
      actor: t.actor,
      content: t.content,
    })),
  });
}
