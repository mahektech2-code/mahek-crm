"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { assertCustomerInScope } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { checkForDuplicate, type DuplicateFound } from "@/lib/erp/order-hub";

/* ---------------------------------------------------------------------------
 * THE DUPLICATE CHECK A TELECALLER'S CALL ASKS BEFORE IT SAVES.
 *
 * Before, never inside: a refusal inside the call's transaction would lose the
 * call. The parties are resolved the way `saveInteraction` resolves them (the
 * billing party defaults to the customer on the call, a delivery party that is
 * the billing party is no delivery party), and the date is the order date of
 * an order received, else today. Scoped like the save: the customer on the
 * call, and the billing party, must be in the caller's book. Null where the
 * ERP does not take the orders, where the call makes no order, or where
 * nothing matches.
 * ------------------------------------------------------------------------- */

export type CallOrderDuplicateInput = {
  customerId: string;
  billingCustomerId?: string;
  deliveryCustomerId?: string;
  interactionType: "outbound_call" | "inbound_call" | "order_received";
  outcome?: string | null;
  orderDate?: string;
  productQuantities: Record<string, number>;
};

export async function checkCallOrderDuplicateAction(input: CallOrderDuplicateInput): Promise<Result<DuplicateFound | null>> {
  try {
    const makesOrder = input.interactionType === "order_received" || input.outcome === "order_taken";
    if (!makesOrder) return ok(null);
    const config = await getConfig();
    if (config["erp.orders.live"] !== true) return ok(null);
    const lines = Object.entries(input.productQuantities ?? {})
      .map(([skuId, q]) => ({ skuId, qtyCans: Math.round(Number(q)) }))
      .filter((l) => Number.isFinite(l.qtyCans) && l.qtyCans > 0);
    if (!lines.length) return ok(null);

    const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId));
    if (!customer) return err("That customer no longer exists.", "not_found");
    await assertCustomerInScope(customer);
    let billingId = customer.id;
    if (input.billingCustomerId && input.billingCustomerId !== customer.id) {
      const [biller] = await db.select().from(customers).where(eq(customers.id, input.billingCustomerId));
      if (!biller) return err("That billing party no longer exists.", "not_found");
      await assertCustomerInScope(biller);
      billingId = biller.id;
    }
    const deliveryId = input.deliveryCustomerId && input.deliveryCustomerId !== billingId ? input.deliveryCustomerId : billingId;
    const date = input.interactionType === "order_received" && input.orderDate ? input.orderDate : await today();
    return ok(await checkForDuplicate({ billingId, deliveryId, date, lines }));
  } catch (e) {
    return fromThrown(e);
  }
}
