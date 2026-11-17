import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { holdBoard } from "@/lib/erp/screens/order-hub";
import { calendarDate } from "@/lib/business-date";
import { nowMs } from "@/lib/format";
import { HoldBoard } from "./hold-board";

/**
 * TO HOLD, drawn as its mockup: every held TO and order from the three
 * departments, with Release beside each and Edit hold behind ⋯. Release is
 * the list's own action, so a hold goes back to the desk that held it.
 */
export const dynamic = "force-dynamic";

export default async function ToHoldPage() {
  const ctx = await erpContext();
  if (!ctx.screens.has("toHold")) redirect("/erp");
  const { rows, releasedThisWeek } = await holdBoard(ctx);
  return <HoldBoard rows={rows} releasedThisWeek={releasedThisWeek} today={calendarDate(new Date(nowMs()))} now={nowMs()} readOnly={ctx.viewingAs != null} />;
}
