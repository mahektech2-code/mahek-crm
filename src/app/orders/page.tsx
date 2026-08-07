import { checkCapability } from "@/lib/access-control";
import { pendingOrders } from "@/lib/services/order-approval-service";
import { ApprovalScreen } from "./approval-screen";

export const metadata = { title: "Order approvals — MahekOne" };

export default async function Page() {
  // App access is gated by the layout. This decides only whether the buttons
  // are live: seeing the queue and deciding on it are different things.
  const [{ allowed }, orders] = await Promise.all([
    checkCapability("order.approve"),
    pendingOrders(),
  ]);

  return (
    <ApprovalScreen
      canApprove={allowed}
      orders={orders.map((o) => ({
        orderId: o.orderId,
        customerId: o.customerId,
        customerName: o.customerName,
        customerCity: o.customerCity,
        contactPerson: o.contactPerson,
        phone: o.phone,
        outstanding: o.outstanding,
        overdueBills: o.overdueBills,
        slowPayer: o.slowPayer,
        creditDays: o.creditDays,
        orderedAt: o.orderedAt.toISOString(),
        takenByName: o.takenByName,
        totalAmount: o.totalAmount,
        lineCount: o.lineCount,
        waitingHours: o.waitingHours,
      }))}
    />
  );
}
