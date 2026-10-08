import Link from "next/link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { dispatchBoard, dispatchQueue } from "@/lib/erp/dispatch";
import { erpLabelsHref, erpTraceHref } from "@/lib/erp/trace-links";
import { calendarDate } from "@/lib/business-date";
import { nowMs } from "@/lib/format";
import { Badge, Card, cx } from "@/components/ui/primitives";
import { Page } from "../_ui/page-head";
import { DispatchDesk } from "./desk";

/**
 * THE DISPATCH DESK. With no order chosen it is the queue: every order with a
 * Ready line not yet dispatch-verified, soonest first, with how many of its
 * boxes are scanned. With one chosen it is the desk: the lines, a scan box
 * that judges every box against them the moment it is scanned, the boxes
 * already on the order, any override waiting, and Do Verified once it is all
 * scanned.
 */
export const dynamic = "force-dynamic";

export default async function ErpDispatch({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("dispatch")) redirect("/erp");
  const sp = await searchParams;
  const today = calendarDate(new Date(nowMs()));
  const orderNo = typeof sp.order === "string" && /^\d+$/.test(sp.order) ? Number(sp.order) : null;

  if (orderNo == null) {
    const queue = await dispatchQueue();
    return (
      <Page title="Dispatch desk" sub="Choose an order, then scan every box going onto the lorry. Each box is checked against the order's product, pack size and quantity as it is scanned.">
        <form action="/erp/dispatch" method="get" className="mb-4 flex max-w-[420px] gap-2">
          <input name="order" inputMode="numeric" placeholder="Order number" autoFocus className="h-10 flex-1 rounded-[4px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand" />
          <button className="h-10 rounded-[4px] bg-brand px-4 text-sm font-medium text-white">Open</button>
        </form>
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[90px_1fr_120px_110px_90px_110px] gap-3 border-b border-divider bg-canvas px-4 py-2 text-[12px] font-medium text-muted">
            <span>Order</span>
            <span>Delivery party</span>
            <span>Godown</span>
            <span>Dispatch on</span>
            <span>Billed</span>
            <span className="text-right">Scanned</span>
          </div>
          {queue.length ? (
            queue.map((o) => (
              <Link key={o.orderNo} href={`/erp/dispatch?order=${o.orderNo}`} className="grid grid-cols-[90px_1fr_120px_110px_90px_110px] items-center gap-3 border-b border-divider px-4 py-2.5 text-sm text-ink no-underline last:border-0 hover:bg-canvas hover:no-underline">
                <span className="font-mono">{o.orderNo}</span>
                <span className="truncate">{o.delivery}</span>
                <span className="truncate text-muted">{o.godown}</span>
                <span className={cx(o.dispatchOn && o.dispatchOn < today ? "text-danger" : "text-body")}>{o.dispatchOn ?? "—"}</span>
                <span>{o.billed ? `${o.billed} of ${o.lines}` : <Badge tone="warn">Not billed</Badge>}</span>
                <span className="text-right tabular-nums">
                  {o.scanned} / {Math.round(o.target)}
                </span>
              </Link>
            ))
          ) : (
            <div className="px-4 py-4 text-sm text-muted">No order is Ready and waiting to leave. A line reaches the desk once it is marked Ready on Orders.</div>
          )}
        </Card>
      </Page>
    );
  }

  const board = await dispatchBoard(orderNo);
  if (!board)
    return (
      <Page title="Dispatch desk">
        <Card className="px-5 py-4 text-sm">
          There is no order {orderNo}. <Link href="/erp/dispatch">Back to the queue</Link>
        </Card>
      </Page>
    );

  return (
    <Page
      title={`Dispatch · order ${board.orderNo}`}
      sub={`${board.delivery}${board.delivery !== board.billing ? ` (billed to ${board.billing})` : ""}${board.area ? ` · ${board.area}` : ""}${board.transporter ? ` · ${board.transporter}` : ""}${board.dispatchOn ? ` · leaves ${board.dispatchOn}` : ""}`}
      actions={
        <div className="flex gap-3 text-[13px]">
          <Link href="/erp/dispatch">← Queue</Link>
          <Link href={erpLabelsHref({ order: board.orderNo })}>Dispatch stickers</Link>
          <Link href={erpTraceHref(`ORDER-${board.orderNo}`)}>Trace</Link>
        </div>
      }
    >
      <DispatchDesk
        board={board}
        me={ctx.user.id}
        canDecide={ctx.powers.has("dispatchOverride")}
        administrator={ctx.administrator}
        canVerify={ctx.screens.has("orderDetails")}
        today={today}
      />
    </Page>
  );
}
