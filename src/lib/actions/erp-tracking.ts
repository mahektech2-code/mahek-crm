"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { erpTransportMessages } from "@/db/schema";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { ErpNotPermitted, requireErpForm, requireErpWrite } from "@/lib/erp/access";
import { isErpManager } from "@/lib/erp/screens/common";

/* ---------------------------------------------------------------------------
 * The order record's Customer tracking tab. Reading it needs the Orders screen
 * (a preview may read); its writes need the screen too — a server action is a
 * URL — and regenerating a link needs an ERP manager, because it cuts off a
 * link the customer may be using.
 * ------------------------------------------------------------------------- */

function refused(e: unknown): Result<never> {
  if (e instanceof ErpNotPermitted) return err(e.message, "not_permitted");
  return fromThrown(e);
}

const orderNo = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

export async function erpOrderTrackingPanel(no: number) {
  try {
    await requireErpForm("orders");
    const n = orderNo(no);
    if (!n) return err("That is not an order number.", "validation");
    const { trackingPanel } = await import("@/lib/erp/order-tracking");
    return ok(await trackingPanel(n));
  } catch (e) {
    return refused(e);
  }
}

export async function erpRegenerateTrackingLink(no: number) {
  try {
    const ctx = await requireErpWrite("orders");
    if (!isErpManager(ctx)) return err("An ERP manager makes a new tracking link — the old one stops working for the customer.", "not_permitted");
    const n = orderNo(no);
    if (!n) return err("That is not an order number.", "validation");
    const { regenerateTracking } = await import("@/lib/erp/order-tracking");
    const res = await regenerateTracking(ctx, n);
    revalidatePath("/erp", "layout");
    return res;
  } catch (e) {
    return refused(e);
  }
}

/** A tracking message somebody sent from their own WhatsApp, or decided not to send. Only a message about an order. */
export async function erpTrackingMessage(messageId: string, act: "sent" | "skip") {
  try {
    const ctx = await requireErpWrite("orders");
    const [m] = await db.select({ orderNo: erpTransportMessages.orderNo }).from(erpTransportMessages).where(eq(erpTransportMessages.id, String(messageId)));
    if (!m?.orderNo) return err("That message is not an order tracking message; it is sent from Logistics.", "not_found");
    const L = await import("@/lib/erp/logistics");
    const res = act === "sent" ? await L.markMessageSent(ctx, String(messageId)) : await L.skipMessage(ctx, String(messageId));
    revalidatePath("/erp", "layout");
    return res;
  } catch (e) {
    return refused(e);
  }
}
