import { NavLink } from "@/components/shell/nav-link";
import { stamp } from "@/lib/format";
import { erpLink } from "@/lib/erp/registry";
import { notFound, redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { getConfig } from "@/lib/config/store";
import { DELIVERY_STATUS_TONE, deliveryStatus } from "@/lib/erp/engines/transport-cost";
import { PHASE_LABEL, shortDay, STAGE_SHORT, stageStep, STAGES, trackingLink } from "@/lib/erp/engines/logistics";
import { billLines, consignments, consignmentsOnLr, eventsFor, messages } from "@/lib/erp/logistics";
import { today as businessToday } from "@/lib/erp/screens/common";
import { erpTraceHref, orderTraceCode } from "@/lib/erp/trace-links";
import { CardGrid } from "@/components/ui/card-grid";
import { Card } from "@/components/ui/primitives";
import { Page, PageLinks } from "../../_ui/page-head";
import { Badge } from "../../_ui/badge";
import { Eyebrow, linkClass, SectionTitle, SubTitle } from "../../_ui/look";
import { CallLink, LrThumb, StageStrip } from "../parts/common";
import { Messages } from "../parts/messages";
import { OnRoad } from "../parts/on-road";
import { TrackLinkCopy } from "./track-link";

/**
 * ONE CONSIGNMENT, whole: where it is, every step and who took it, what the
 * customer was told and whether it reached them, and — while it is on the
 * road — the same card and buttons the On the road tab draws.
 */
export const dynamic = "force-dynamic";

const KIND: Record<string, string> = {
  opened: "Left the factory",
  due: "Planned at the transporter",
  at_transport: "Reached the transporter",
  lr: "LR attached",
  lr_removed: "Taken off an LR",
  call: "Called the transporter",
  stage: "Status updated",
  issue: "Problem reported",
  issue_cleared: "Problem solved",
  delivered: "Delivered",
  reopened: "Reopened",
  trip: "Vehicle trip",
};

export default async function ConsignmentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await erpContext();
  if (!ctx.screens.has("transport")) redirect("/erp");
  const { id } = await params;
  const [c] = await consignments({ ids: [id] });
  if (!c) notFound();
  const siblings = c.lrId ? await consignmentsOnLr(c.lrId) : [c];
  const [events, msgs, lines, cfg] = await Promise.all([eventsFor([c.id]), messages({ transportId: c.id }), billLines(c.orderNo, c.id), getConfig()]);
  const today = businessToday();
  const online = trackingLink(c.transporterTrackUrl, c.lrNo);
  const status = deliveryStatus(c, today);

  const fact = (l: string, v: React.ReactNode) => (
    <div>
      <Eyebrow>{l}</Eyebrow>
      <div className="mt-0.5 text-sm text-ink">{v ?? "—"}</div>
    </div>
  );

  return (
    <Page
      title={`${c.billNo ?? `Order ${c.orderNo}`} · ${c.deliveryParty}`}
      sub={`${PHASE_LABEL[c.phase]} · ${STAGE_SHORT[STAGES[stageStep(c.stage)]]}`}
      actions={
        <PageLinks>
          <NavLink href={erpLink("transport")} className={linkClass()}>
            ← Logistics
          </NavLink>
          <NavLink href={erpTraceHref(orderTraceCode(c.orderNo))} className={linkClass()}>
            Trace
          </NavLink>
        </PageLinks>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(300px,380px)] items-start gap-5">
        <div className="space-y-5">
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <StageStrip stage={c.stage} />
              <Badge label={status} tone={DELIVERY_STATUS_TONE[status]} />
            </div>
            <CardGrid min={150} className="mt-4">
              {fact("Billed to", c.party)}
              {fact("Delivered to", c.deliveryParty)}
              {fact("Area", c.area ?? c.partyCity)}
              {fact("Left factory", c.billDate ? `${shortDay(c.billDate)}${c.godown ? ` · ${c.godown}` : ""}` : null)}
              {fact("Boxes", c.packages)}
              {fact("Litres", c.litres)}
              {fact("Freight", c.paymentType)}
              {fact(
                "Vehicle trip",
                c.tripNo != null ? (
                  <NavLink href={erpLink("trips")} className={linkClass()}>
                    Trip {c.tripNo}
                    {c.vehicleNo ? ` · ${c.vehicleNo}` : ""}
                  </NavLink>
                ) : c.vehicleNo ? (
                  `Vehicle ${c.vehicleNo} · on no trip`
                ) : (
                  <span className="text-warn">No vehicle recorded</span>
                ),
              )}
              {fact("Transporter", c.transporter ? <span>{c.transporter}<span className="block"><CallLink phone={c.transporterPhone} name={c.transporter} /></span></span> : null)}
              {fact("Expected delivery", c.expectedDeliveryOn ? shortDay(c.expectedDeliveryOn) : null)}
              {fact("Next call", c.nextCallOn ? shortDay(c.nextCallOn) : null)}
              {c.deliveredOn ? fact("Delivered", `${shortDay(c.deliveredOn)}${c.receivedBy ? ` · ${c.receivedBy}` : ""}`) : null}
              {c.deliveredOn ? fact("Confirmed by", c.deliveredBy) : null}
              {c.deliveredOn ? fact("Proof / reference", c.deliveryProof) : null}
              {c.issue ? fact("Problem", <Badge label={c.issue} tone="danger" />) : null}
            </CardGrid>
            {c.issueNote ? <div className="mt-3 text-meta text-danger">{c.issueNote}</div> : null}
          </Card>

          {c.phase === "onRoad" ? (
            <OnRoad rows={siblings.filter((x) => x.phase === "onRoad")} today={today} callEveryDays={cfg["erp.logistics.callEveryDays"]} lateAfterDays={cfg["erp.logistics.lateAfterDays"]} notifyOn={cfg["erp.logistics.notifyCustomers"]} canWrite={!ctx.viewingAs} />
          ) : c.phase === "delivered" ? null : (
            <Card className="px-4 py-3 text-sm">
              {c.phase === "toTransport" ? (
                <>
                  On its way to the transporter. <NavLink href={erpLink("toTransport")} className={linkClass()}>Plan or mark it reached on To transporter →</NavLink>
                </>
              ) : (
                <>
                  At the transporter, waiting for its LR. <NavLink href={erpLink("pendingLr")} className={linkClass()}>Attach it on the Documents desk →</NavLink>
                </>
              )}
            </Card>
          )}

          <Card className="overflow-hidden">
            <SubTitle className="mb-0 border-b border-divider px-4 py-3">On this bill</SubTitle>
            {lines.map((l) => (
              <div key={l.id} className="flex items-center gap-3 border-b border-divider px-4 py-2 text-sm last:border-0">
                <span className="min-w-0 flex-1 truncate">{l.sku}</span>
                <span className="tabular-nums text-body">{l.cans} {l.cans === 1 ? "can" : "cans"}</span>
                {l.status !== "Ready" ? <Badge label={l.status} tone="muted" /> : null}
              </div>
            ))}
          </Card>

          <div>
            <SectionTitle>What the customer was told</SectionTitle>
            <Messages rows={msgs} canWrite={!ctx.viewingAs} wati={cfg["erp.logistics.watiTemplate"].trim() || null} />
          </div>
        </div>

        <div className="space-y-5">
          {c.lrNo ? (
            <Card className="flex gap-3 p-4">
              <LrThumb fileId={c.lrFileId} size={84} />
              <div className="min-w-0">
                <SubTitle className="mb-0 font-mono">LR {c.lrNo}</SubTitle>
                <div className="text-xs text-muted">{c.lrDate ? shortDay(c.lrDate) : ""}</div>
                {siblings.length > 1 ? <div className="mt-1 text-meta text-body">Carries {siblings.length} bills: {siblings.map((s) => s.billNo ?? s.orderNo).join(", ")}</div> : null}
                {online ? (
                  <a href={online} target="_blank" rel="noreferrer" className={linkClass("brand", "mt-1 block text-meta")}>
                    Track on {c.transporter}&apos;s site ↗
                  </a>
                ) : null}
              </div>
            </Card>
          ) : null}
          {c.trackToken ? <TrackLinkCopy token={c.trackToken} /> : null}
          <Card className="overflow-hidden">
            <SubTitle className="mb-0 border-b border-divider px-4 py-3">Timeline</SubTitle>
            {events.length ? (
              <ol className="relative px-4 py-3">
                {events.map((e) => (
                  <li key={e.id} className="relative border-l border-line pb-4 pl-4 last:pb-0">
                    <span className={`absolute top-1 -left-[5px] h-2.5 w-2.5 rounded-full ${e.kind === "issue" ? "bg-danger" : e.kind === "delivered" ? "bg-success" : "bg-brand"}`} />
                    <div className="text-sm font-medium text-ink">{KIND[e.kind] ?? e.kind}</div>
                    {e.note ? <div className="text-meta text-body">{e.note}</div> : null}
                    <div className="text-xs text-muted">
                      {stamp(e.at)}
                      {e.by ? ` · ${e.by}` : ""}
                      {!e.shared ? " · not shown to the customer" : ""}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="px-4 py-3 text-meta text-muted">Nothing recorded yet.</div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}
