import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { erpOrderIntakes, erpOrders } from "@/db/schema";
import { err, ok, type Result } from "@/lib/result";
import type { ErpContext } from "./access";
import { checkIntake } from "./order-hub";
import { screenModule } from "./screens";

/* ---------------------------------------------------------------------------
 * FOR TESTS: an order taken on the ERP's New order form and carried through
 * the Order Hub the way people carry it — both checks, Accounts' approval and
 * the Production Head's clearance — so a test about billing or dispatch starts
 * from an order the floor may work. Every step is the real one; only the people
 * are one administrator. A test about the hub itself calls the steps directly.
 * ------------------------------------------------------------------------- */

export type Placed = Result<unknown> & { orderNo?: number; toNo?: number };

export async function placeOrder(ctx: ErpContext, h: Record<string, string>, ls: Record<string, string>[], opts: { gates?: boolean } = {}): Promise<Placed> {
  const r = await screenModule("orders")!.forms!.new!(ctx, h, ls);
  if (!r.ok) return r;
  const toNo = Number(/TO-(\d+)/.exec(r.message ?? "")?.[1]);
  if (!toNo) return err(`No TO in "${r.message}"`);
  const [i] = await db.select().from(erpOrderIntakes).where(eq(erpOrderIntakes.toNo, toNo));
  const admin = { userId: ctx.user.id, backOffice: true, production: true, admin: true };
  for (let n = 0; n < 2; n++) {
    const c = await checkIntake(admin, i.id, null);
    if (!c.ok) return c;
  }
  const [made] = await db.select({ no: erpOrderIntakes.orderNo }).from(erpOrderIntakes).where(eq(erpOrderIntakes.id, i.id));
  const orderNo = Number(made.no);
  if (opts.gates !== false) await clearGates(orderNo);
  return { ...ok(undefined, `Order ${orderNo} saved`), orderNo, toNo };
}

/** Accounts approved and the Production Head cleared — the two gates after the order number, as a test needs them out of the way. */
export async function clearGates(orderNo: number): Promise<void> {
  await db
    .update(erpOrders)
    .set({ accountsCheck: "Approved", accountsCheckedAt: new Date(), productionCheck: "Cleared", productionCheckedAt: new Date() })
    .where(and(eq(erpOrders.orderNo, orderNo)));
  const { syncBookOrders } = await import("./book");
  await syncBookOrders([orderNo]);
}
