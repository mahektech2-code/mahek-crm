import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { money, phoneDisplay, stampDate } from "@/lib/format";
import { heldOrders, pendingOrders } from "@/lib/services/order-approval-service";
import { accountsTos } from "@/lib/services/to-approval-service";
import { ToApprovals } from "./to-approvals";
import { QueueScreen } from "../queue-screen";
import { reasonLabel } from "@/lib/erp/engines/order-tracking";
import { HeldOrders } from "./held-orders";
import type { QueueRow } from "../queue-types";

export const metadata = { title: "Order approvals — Accounts — MahekOne" };

export default async function Page() {
  // App access is gated by the layout. This decides only whether the buttons
  // are live: seeing the queue and deciding on it are different things.
  const [{ allowed }, orders, config, held, tos] = await Promise.all([
    checkCapability("order.approve"),
    pendingOrders(),
    getConfig(),
    heldOrders(),
    accountsTos(),
  ]);

  const rows: QueueRow[] = orders.map((o) => ({
    id: o.orderId,
    customerId: o.customerId,
    customerName: o.customerName,
    amount: o.totalAmount,
    waitingHours: o.waitingHours,
    byName: o.takenByName ?? "—",
    /*
     * The DATE, with no time of day, because the time of day is not a fact.
     *
     * A CRM order is stamped 09:00 on the date it is FOR — the telecaller can
     * state a past date when an order arrived before anybody logged it, so the
     * clock part is a filler the capture path writes and nothing about the
     * call. Printing it beside a real name read as "Poonam took this at nine
     * in the morning", which nobody could have known and which was not true.
     *
     * How long it has been waiting is the thing accounts actually need from
     * this column, and that is its own field, measured from the real
     * `created_at`.
     */
    byWhen: stampDate(o.orderedAt),
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

  /* The TO queue first (Option A: Accounts approve every TO, and that makes the
     order number). Orders that reached Accounts another way — numbered before
     TOs, or taken while the ERP does not yet take the orders — keep the queue
     they always had, below, only while there are any. */
  return (
    <>
      <ToApprovals waiting={tos.waiting} sentBack={tos.sentBack} held={tos.held} canDecide={allowed} />
      {rows.length ? (
      <QueueScreen
        title="Other orders waiting"
        kind="orders"
        rows={rows}
        canDecide={allowed}
        staleHours={config["payments.confirmationAgeWarningHours"]}
        quietDays={config["payments.reportedQuietDays"]}
      />
      ) : null}
      <HeldOrders
        canDecide={allowed}
        rows={held.map((h) => ({ ...h, reason: reasonLabel(h.reason), heldAt: h.heldAt.toISOString() }))}
      />
    </>
  );
}
