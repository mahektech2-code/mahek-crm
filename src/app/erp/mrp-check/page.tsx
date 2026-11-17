import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { mrpBoard } from "@/lib/erp/screens/order-hub";
import { erpLink } from "@/lib/erp/registry";
import { MrpBoard } from "./mrp-board";

/**
 * THE MRP CHECK, drawn as its mockup: the orders Accounts approved on the
 * left, and the one chosen on the right — its goods against the shelf and the
 * tank, the materials its base takes, the capacity tick, a note, Hold and
 * Clear for production. The rules are `mrpCheck` and the list's own actions.
 */
export const dynamic = "force-dynamic";

export default async function MrpCheckPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("mrpCheck")) redirect("/erp");
  const sp = await searchParams;
  const open = typeof sp.open === "string" ? sp.open : null;
  const orders = await mrpBoard(ctx);
  const orderLinks = Object.fromEntries(orders.map((o) => [o.orderNo, erpLink("orders", { fl: `Order ${o.orderNo}` })]));
  return <MrpBoard orders={orders} initialOpen={open} orderLinks={orderLinks} toHoldHref={erpLink("toHold")} readOnly={ctx.viewingAs != null} />;
}
