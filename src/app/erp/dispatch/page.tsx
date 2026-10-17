import Link from "next/link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpScreen } from "@/lib/erp/registry";
import { dispatchBoard, dispatchQueue } from "@/lib/erp/dispatch";
import { lrUploadKit } from "@/lib/erp/logistics";
import { erpDispatchHref, erpLabelsHref, erpTraceHref, orderTraceCode } from "@/lib/erp/trace-links";
import { fd } from "@/lib/erp/ui";
import { calendarDate } from "@/lib/business-date";
import { nowMs } from "@/lib/format";
import { Badge, Card, cx } from "@/components/ui/primitives";
import { Page, PageLinks, QuickFind } from "../_ui/page-head";
import { UploadLrsButton } from "../transport/parts/upload-lrs-button";
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

/* The title and the line under it are the registry's, as on every list. */
const SCREEN = erpScreen("dispatch")!;

export default async function ErpDispatch({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("dispatch")) redirect("/erp");
  const sp = await searchParams;
  const today = calendarDate(new Date(nowMs()));
  const orderNo = typeof sp.order === "string" && /^\d+$/.test(sp.order) ? Number(sp.order) : null;

  if (orderNo == null) {
    const [queue, kit] = await Promise.all([dispatchQueue(), ctx.viewingAs ? Promise.resolve(null) : lrUploadKit()]);
    const upload = typeof sp.upload === "string" ? sp.upload : "";
    return (
      <Page
        title={SCREEN.label}
        sub={SCREEN.sub}
        actions={kit ? <UploadLrsButton key={upload} variant="secondary" today={today} transporters={kit.transporters} recent={kit.recent} canRead={kit.canRead} initialOpen={upload === "1"} /> : null}
      >
        <QuickFind action="/erp/dispatch" name="order" inputMode="numeric" placeholder="Order number" button="Open" className="mb-4 max-w-[420px]" />
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[90px_1fr_120px_110px_90px_110px] gap-3 border-b border-divider bg-canvas px-4 py-2 text-xs font-medium text-muted">
            <span>Order</span>
            <span>Delivery party</span>
            <span>Godown</span>
            <span>Dispatch on</span>
            <span>Billed</span>
            <span className="text-right">Scanned</span>
          </div>
          {queue.length ? (
            queue.map((o) => (
              <Link key={o.orderNo} href={erpDispatchHref(o.orderNo)} className="grid grid-cols-[90px_1fr_120px_110px_90px_110px] items-center gap-3 border-b border-divider px-4 py-2.5 text-sm text-ink no-underline last:border-0 hover:bg-canvas hover:no-underline">
                <span className="font-mono">{o.orderNo}</span>
                <span className="truncate">{o.delivery}</span>
                <span className="truncate text-muted">{o.godown}</span>
                <span className={cx(o.dispatchOn && o.dispatchOn < today ? "text-danger" : "text-body")}>{o.dispatchOn ? fd(o.dispatchOn) : "—"}</span>
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
      <Page title={SCREEN.label}>
        <Card className="px-5 py-4 text-sm">
          There is no order {orderNo}. <Link href={erpDispatchHref()}>Back to the queue</Link>
        </Card>
      </Page>
    );

  return (
    <Page
      title={`Dispatch · order ${board.orderNo}`}
      sub={`${board.delivery}${board.delivery !== board.billing ? ` (billed to ${board.billing})` : ""}${board.area ? ` · ${board.area}` : ""}${board.transporter ? ` · ${board.transporter}` : ""}${board.dispatchOn ? ` · leaves ${fd(board.dispatchOn)}` : ""}`}
      actions={
        <PageLinks>
          <Link href={erpDispatchHref()}>← Queue</Link>
          <Link href={erpLabelsHref({ order: board.orderNo })}>Dispatch labels</Link>
          <Link href={erpTraceHref(orderTraceCode(board.orderNo))}>Trace</Link>
        </PageLinks>
      }
    >
      <DispatchDesk
        board={board}
        me={ctx.user.id}
        canDecide={ctx.powers.has("dispatchOverride")}
        administrator={ctx.administrator}
        canVerify={ctx.screens.has("orderDetails")}
        canAllocate={ctx.screens.has("orders")}
        today={today}
      />
    </Page>
  );
}
