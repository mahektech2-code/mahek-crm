import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { money, phoneDisplay, stamp } from "@/lib/format";
import { pendingOrders } from "@/lib/services/order-approval-service";
import { QueueScreen } from "../queue-screen";
import type { QueueRow } from "../queue-types";

export const metadata = { title: "Order approvals — Accounts — MahekOne" };

export default async function Page() {
  // App access is gated by the layout. This decides only whether the buttons
  // are live: seeing the queue and deciding on it are different things.
  const [{ allowed }, orders, config] = await Promise.all([
    checkCapability("order.approve"),
    pendingOrders(),
    getConfig(),
  ]);

  const rows: QueueRow[] = orders.map((o) => ({
    id: o.orderId,
    customerId: o.customerId,
    customerName: o.customerName,
    amount: o.totalAmount,
    waitingHours: o.waitingHours,
    byName: o.takenByName ?? "—",
    byWhen: stamp(o.orderedAt),
    // Imported customers often carry no contact person and no city. An empty
    // part is dropped rather than joined, or the line opens with a stray "·".
    byMeta: [o.contactPerson, phoneDisplay(o.phone), o.customerCity]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" · "),
    middle: String(o.lineCount),
    // What accounts are checking before anything else: can this customer take
    // on more credit.
    context: o.outstanding > 0 ? money(o.outstanding) : "—",
    contextTone: o.outstanding > 0 ? "danger" : "muted",
    slowPayer: o.slowPayer,
    overdueBills: o.overdueBills,
  }));

  return (
    <QueueScreen
      kind="orders"
      rows={rows}
      canDecide={allowed}
      staleHours={config["payments.confirmationAgeWarningHours"]}
      quietDays={config["payments.reportedQuietDays"]}
    />
  );
}
