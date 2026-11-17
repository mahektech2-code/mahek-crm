import { checkCapability } from "@/lib/access-control";
import { heldOrders } from "@/lib/services/order-approval-service";
import { reasonLabel } from "@/lib/erp/engines/order-tracking";
import { HeldOrders } from "../held-orders";

export const metadata = { title: "Orders on hold — Accounts — MahekOne" };

/** The orders Accounts hold, on a page of their own beside Order approvals. */
export default async function Page() {
  const [{ allowed }, held] = await Promise.all([checkCapability("order.approve"), heldOrders()]);
  return <HeldOrders canDecide={allowed} standalone rows={held.map((h) => ({ ...h, reason: reasonLabel(h.reason), heldAt: h.heldAt.toISOString() }))} />;
}
