import { checkCapability } from "@/lib/access-control";
import { heldOrders } from "@/lib/services/order-approval-service";
import { reasonLabel } from "@/lib/erp/engines/order-tracking";
import { HeldOrders } from "../held-orders";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";

export const metadata = { title: "Orders on hold — Accounts — MahekOne" };

/** The orders Accounts hold, on a page of their own beside Order approvals. */
export default async function Page() {
  const user = await requireUser();
  const [{ allowed }, held, apps] = await Promise.all([checkCapability("order.approve"), heldOrders(), listUserApps(user.id)]);
  return (
    <HeldOrders
      canDecide={allowed}
      standalone
      erpOrders={apps.includes("erp")}
      rows={held.map((h) => ({ ...h, reason: reasonLabel(h.reason), heldAt: h.heldAt.toISOString() }))}
    />
  );
}
