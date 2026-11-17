import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { hubBoard } from "@/lib/erp/screens/order-hub";
import { nowMs } from "@/lib/format";
import { HubBoard, type HubTab } from "./hub-board";

/**
 * THE ORDER HUB: every TO waiting for Accounts, how long it has waited, and
 * Edit TO / Cancel TO behind each row (`hubActions`). Accounts approve a TO
 * in Accounts > Order approvals, and that makes the order number.
 */
export const dynamic = "force-dynamic";

const VIEW_TAB: Record<string, HubTab> = { orderHub: "waiting", hubCorrection: "correction", hubDone: "verified" };

export default async function OrderHubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("orderHub")) redirect("/erp");
  const sp = await searchParams;
  const view = typeof sp.view === "string" ? VIEW_TAB[sp.view] : undefined;
  const open = typeof sp.open === "string" ? sp.open : null;
  const { rows, seeMoney } = await hubBoard(ctx);
  return <HubBoard rows={rows} seeMoney={seeMoney} now={nowMs()} initialTab={view ?? null} initialOpen={open} readOnly={ctx.viewingAs != null} />;
}
