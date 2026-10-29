import { NavLink } from "@/components/shell/nav-link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpScreen } from "@/lib/erp/registry";
import { dispatchBoard, dispatchQueue } from "@/lib/erp/dispatch";
import { lrUploadKit } from "@/lib/erp/logistics";
import { erpDispatchHref, erpLabelsHref, erpTraceHref, orderTraceCode } from "@/lib/erp/trace-links";
import { fd } from "@/lib/erp/ui";
import { calendarDate } from "@/lib/business-date";
import { nowMs } from "@/lib/format";
import { Card, cx, EmptyState } from "@/components/ui/primitives";
import { Page, PageLinks, QuickFind } from "../_ui/page-head";
import { linkClass } from "../_ui/look";
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

  /* v4: the queue is always down the left as cards, and the order being
     scanned fills the right — the queue never leaves the screen. */
  const [queue, kit, board] = await Promise.all([
    dispatchQueue(),
    ctx.viewingAs ? Promise.resolve(null) : lrUploadKit(),
    orderNo == null ? Promise.resolve(null) : dispatchBoard(orderNo),
  ]);
  const upload = typeof sp.upload === "string" ? sp.upload : "";
  const uploadButton = kit ? <UploadLrsButton key={upload} variant="secondary" today={today} transporters={kit.transporters} recent={kit.recent} canRead={kit.canRead} initialOpen={upload === "1"} /> : null;

  return (
    <Page
      title={SCREEN.label}
      actions={
        board ? (
          <>
            <PageLinks>
              <NavLink href={erpDispatchHref()} className={linkClass()}>
                ← Queue
              </NavLink>
              <NavLink href={erpLabelsHref({ order: board.orderNo })} className={linkClass()}>
                Dispatch labels
              </NavLink>
              <NavLink href={erpTraceHref(orderTraceCode(board.orderNo))} className={linkClass()}>
                Trace
              </NavLink>
            </PageLinks>
            {uploadButton}
          </>
        ) : (
          uploadButton
        )
      }
    >
      <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2.5">
          <QuickFind action={erpDispatchHref()} name="order" inputMode="numeric" placeholder="Order number" button="Open" className="mb-0.5" />
          {queue.length ? (
            queue.map((o) => {
              const done = o.target > 0 && o.scanned >= Math.round(o.target);
              const pct = o.target ? Math.min(100, Math.round((100 * o.scanned) / o.target)) : 0;
              return (
                <NavLink
                  key={o.orderNo}
                  href={erpDispatchHref(o.orderNo)}
                  aria-current={o.orderNo === orderNo ? "page" : undefined}
                  className={cx(
                    "flex flex-col gap-2 rounded-[10px] border bg-surface px-3.5 py-3 text-ink no-underline hover:no-underline",
                    o.orderNo === orderNo ? "border-brand ring-3 ring-brand-soft" : "border-line hover:border-line-strong",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{o.delivery}</span>
                    <span className="flex-none font-mono text-xs text-faint">{o.orderNo}</span>
                  </span>
                  <span className="truncate text-xs text-muted">
                    {o.godown} · <span className={cx(o.dispatchOn && o.dispatchOn < today ? "text-danger" : undefined)}>{o.dispatchOn ? `leaves ${fd(o.dispatchOn)}` : "no date"}</span> ·{" "}
                    {o.billed ? `billed ${o.billed} of ${o.lines}` : <span className="text-warn-ink">not billed</span>}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-divider">
                      <span className={cx("block h-full rounded-full", done ? "bg-success" : "bg-brand")} style={{ width: `${pct}%` }} />
                    </span>
                    <span className="flex-none text-meta text-body tabular-nums">
                      {o.scanned}/{Math.round(o.target)}
                    </span>
                  </span>
                </NavLink>
              );
            })
          ) : (
            <Card>
              <EmptyState title="No order is Ready and waiting to leave." body="A line reaches the desk once it is marked Ready on Orders." />
            </Card>
          )}
        </div>

        {board ? (
          <DispatchDesk
            board={board}
            me={ctx.user.id}
            canDecide={ctx.powers.has("dispatchOverride")}
            administrator={ctx.administrator}
            canVerify={ctx.screens.has("orderDetails")}
            canAllocate={ctx.screens.has("orders")}
            today={today}
          />
        ) : (
          <Card>
            <EmptyState
              title={orderNo != null ? `There is no order ${orderNo}.` : "Pick an order to scan"}
              body={orderNo != null ? undefined : "Choose one on the left, or type its number above. Every box is scanned onto it before the lorry leaves."}
              action={
                orderNo != null ? (
                  <NavLink href={erpDispatchHref()} className={linkClass()}>
                    Back to the queue
                  </NavLink>
                ) : undefined
              }
            />
          </Card>
        )}
      </div>
    </Page>
  );
}
