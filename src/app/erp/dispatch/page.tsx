import { NavLink } from "@/components/shell/nav-link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { erpScreen } from "@/lib/erp/registry";
import { dispatchBoard, dispatchQueue, pickableBoxes } from "@/lib/erp/dispatch";
import { lrUploadKit } from "@/lib/erp/logistics";
import { erpDispatchHref, erpLabelsHref, erpTraceHref, orderTraceCode } from "@/lib/erp/trace-links";
import { calendarDate } from "@/lib/business-date";
import { nowMs } from "@/lib/format";
import { Card, EmptyState } from "@/components/ui/primitives";
import { Page, PageLinks } from "../_ui/page-head";
import { linkClass } from "../_ui/look";
import { UploadLrsButton } from "../transport/parts/upload-lrs-button";
import { DispatchDesk } from "./desk";
import { DispatchQueue } from "./queue";

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
  /* The boxes that could go on it, for picking off a list when a QR will not read. */
  const boxes = board && !ctx.viewingAs ? await pickableBoxes(board) : [];
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
        <DispatchQueue queue={queue} current={orderNo} today={today} />

        {board ? (
          <DispatchDesk
            board={board}
            boxes={boxes}
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
              body={orderNo != null ? undefined : "Find it on the left by party, area, transporter or product, or type its number. Every box is scanned onto it before the lorry leaves."}
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
