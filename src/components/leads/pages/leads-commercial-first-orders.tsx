import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import {
  canLead,
  leadOrders,
  leadReceipts,
  type LeadOrderRow,
  type LeadReceiptRow,
} from "@/lib/services/lead-console-service";
import { firstOrderDesk } from "@/lib/services/lead-commercial-service";
import { FirstOrdersScreen } from "@/components/leads/commercial/first-orders/first-orders-screen";


/**
 * 18 — the order that converts an account, and the three rungs after it.
 *
 * The detail is fetched for ONE account rather than carried on every row.
 * `leadOrders` and `leadReceipts` each read fifty rows with a bill joined, and
 * two hundred of those to draw a table nobody has clicked into is a query the
 * screen pays for and never reads — the same argument the customer quick view
 * makes for fetching on click.
 *
 * An `open` id that is not on the desk answers with nothing to show rather
 * than an error: a bookmark outlives a rung, and a lead that has since been
 * promoted off this list is absent to the reader, never a crash.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ open?: string }>;
}) {
  const { open } = await searchParams;

  const day = await today();
  const [user, desk] = await Promise.all([requireUser(), firstOrderDesk(day)]);

  const selected = open && desk.rows.some((r) => r.customerId === open) ? open : null;
  let orders: LeadOrderRow[] = [];
  let receipts: LeadReceiptRow[] = [];
  if (selected) {
    [orders, receipts] = await Promise.all([leadOrders(selected), leadReceipts(selected)]);
  }

  return (
    <FirstOrdersScreen workspace={workspace}
      rows={desk.rows}
      total={desk.total}
      byStage={desk.byStage}
      awaitingTheOrder={desk.awaitingTheOrder}
      awaitingApproval={desk.awaitingApproval}
      selectedId={selected}
      orders={orders}
      receipts={receipts}
      canWork={await canLead(user, "lead.work")}
    />
  );
}
