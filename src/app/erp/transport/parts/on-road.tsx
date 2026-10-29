"use client";

import { NavLink } from "@/components/shell/nav-link";
import { erpLink } from "@/lib/erp/registry";
import { useMemo, useState } from "react";
import { FilterPills } from "@/components/ui/overlays";
import { Button, Card, cx, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogFooter, DialogHeader, ErpDialog, DialogTitle } from "../../_ui/dialog";
import { linkClass, SubTitle } from "../../_ui/look";
import { erpLogisticsClearIssue, erpLogisticsDelivered, erpLogisticsIssue, erpLogisticsUpdate } from "@/lib/actions/erp-logistics";
import { addDays, callDue, daysBetween, ISSUES, runningLate, shortDay, trackingLink } from "@/lib/erp/engines/logistics";
import { delayReasonForIssue, reasonsFor } from "@/lib/erp/engines/order-tracking";
import type { Consignment, RouteSuggestions } from "@/lib/erp/logistics";
import { UpdateLrDialog } from "./update-lr";
import { BillRef, byLr, CallLink, DeliveryStatusBadge, DuePill, Empty, LrThumb, NotifyToggle, plural, RouteTrail, StageStrip, sumPackages, useAct, lrLabel, vehicleWords } from "./common";

/**
 * STEP 5 AND 6 — following the lorry. One card per LR (one LR is one
 * consignment), with the transporter's number to ring, where it is, when the
 * next call is owed and what was last said. An update that moves the stage is
 * shared with the customer; a problem can be raised, and the card closes when
 * the party has the goods.
 */
type Filter = "all" | "calls" | "late" | "issue";
type Dialog = { kind: "update" | "issue" | "delivered"; group: Consignment[] } | null;

export function OnRoad({
  rows,
  today,
  callEveryDays,
  lateAfterDays,
  notifyOn,
  canWrite,
  suggestions,
  initialFilter,
}: {
  rows: Consignment[];
  today: string;
  callEveryDays: number;
  lateAfterDays: number;
  notifyOn: boolean;
  canWrite: boolean;
  suggestions?: RouteSuggestions | null;
  initialFilter?: Filter;
}) {
  const { run, pending } = useAct();
  const [filter, setFilter] = useState<Filter>(initialFilter ?? "all");
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);

  const groups = useMemo(() => byLr(rows), [rows]);
  const isLate = (g: Consignment[]) => g.some((c) => runningLate({ expectedDeliveryOn: c.expectedDeliveryOn, billDate: c.billDate, materialStage: c.stage }, today, lateAfterDays));
  const isCall = (g: Consignment[]) => g.some((c) => callDue({ reminderDate: c.nextCallOn, materialStage: c.stage }, today));
  const counts = { all: groups.length, calls: groups.filter((g) => isCall(g.bills)).length, late: groups.filter((g) => isLate(g.bills)).length, issue: groups.filter((g) => g.bills.some((c) => c.issue)).length };
  const needle = q.trim().toLowerCase();
  const shown = groups
    .filter((g) => (filter === "calls" ? isCall(g.bills) : filter === "late" ? isLate(g.bills) : filter === "issue" ? g.bills.some((c) => c.issue) : true))
    .filter((g) => !needle || g.bills.some((c) => [c.lrNo, c.billNo, c.party, c.deliveryParty, c.transporter, String(c.orderNo), c.area, c.currentCity, c.destination, c.dispatchedFrom].some((x) => x?.toLowerCase().includes(needle))))
    .sort((a, b) => (a.bills[0].nextCallOn ?? "9999") .localeCompare(b.bills[0].nextCallOn ?? "9999"));

  const calledNoChange = (g: Consignment[]) => run(() => erpLogisticsUpdate(g.map((c) => c.id), { note: "Called the transporter — no change", nextCallOn: addDays(today, callEveryDays), notify: false }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <FilterPills<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "Everything on the road", count: counts.all },
            { key: "calls", label: "Call today", count: counts.calls },
            { key: "late", label: "Running late", count: counts.late },
            { key: "issue", label: "With a problem", count: counts.issue },
          ]}
        />
        <span className="ml-auto w-[260px]">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search LR, bill, party, transporter, city" aria-label="Search LR, bill, party, transporter, city" />
        </span>
      </div>

      {!shown.length ? (
        <Card>
          <Empty>{groups.length ? "Nothing matches." : "Nothing is on the road. A bill comes here when its LR is attached on the LR desk."}</Empty>
        </Card>
      ) : null}

      {shown.map(({ key, bills }) => {
        const c = bills[0];
        const late = isLate(bills);
        const issue = bills.find((b) => b.issue);
        const boxes = sumPackages(bills);
        const parties = [...new Set(bills.map((b) => b.deliveryParty))];
        const since = c.lrDate ?? c.billDate;
        const online = trackingLink(c.transporterTrackUrl, c.lrNo);
        const waiting = bills.reduce((a, b) => Math.max(a, b.messagesWaiting), 0);
        return (
          <Card key={key} className={cx("overflow-hidden", issue ? "border-danger/50" : late ? "border-warn/60" : "")}>
            <div className="flex flex-wrap items-start gap-4 px-4 py-3">
              <LrThumb fileId={c.lrFileId} size={60} />
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SubTitle className="mb-0 font-mono">{lrLabel(c.lrNo)}</SubTitle>
                  <span className="text-meta text-body">· {c.transporter ?? "—"}</span>
                  <DeliveryStatusBadge c={issue ?? c} today={today} />
                  {issue ? <Badge label={issue.issue ?? ""} tone="danger" /> : null}
                  {late && !issue ? <Badge label="Running late" tone="warn" /> : null}
                  {waiting ? (
                    <NavLink href={erpLink("lrMessages")}>
                      <Badge label={`${plural(waiting, "message")} to send`} tone="warn" />
                    </NavLink>
                  ) : null}
                </div>
                <div className="mt-0.5 text-sm font-medium text-ink">{parties.join(", ")}</div>
                <div className="text-meta text-muted">
                  {bills.map((b, i) => (
                    <span key={b.id}>
                      {i ? ", " : ""}
                      <BillRef c={b} />
                    </span>
                  ))}
                  {boxes != null ? ` · ${plural(boxes, "box", "boxes")}` : ""}
                  {c.area ? ` · ${c.area}` : ""}
                  {since ? ` · ${daysBetween(since, today)} d on the road` : ""}
                  {` · ${vehicleWords(c)}`}
                </div>
                {c.route.length || c.destination ? <RouteTrail route={c.route} destination={c.destination} stage={c.stage} className="mt-1.5" /> : null}
                {c.stage === "Ready for Pickup" && c.pickupPoint ? (
                  <div className="mt-1 text-meta text-body">
                    Party collects from <span className="font-medium text-ink">{c.pickupPoint}</span>
                    {c.pickupContact ? ` · ${c.pickupContact}` : ""}
                  </div>
                ) : null}
                {issue?.issueNote ? <div className="mt-1 text-meta text-danger">{issue.issueNote}</div> : null}
                {c.lastEventNote ? <div className="mt-1 truncate text-meta text-body">Last: {c.lastEventNote}</div> : null}
              </div>
              <div className="w-[270px] space-y-1.5">
                <StageStrip stage={c.stage} />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>Expected</span>
                  {c.expectedDeliveryOn ? <span className={cx("font-medium", late ? "text-danger" : "text-body")}>{shortDay(c.expectedDeliveryOn)}</span> : <span>—</span>}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span>Next call</span>
                  <DuePill day={c.nextCallOn} today={today} />
                </div>
              </div>
              <div className="w-[190px] space-y-1.5 text-right">
                <CallLink phone={c.transporterPhone} name={c.transporter} />
                {online ? (
                  <a href={online} target="_blank" rel="noreferrer" className={linkClass("brand", "block text-meta")}>
                    Track on {c.transporter}&apos;s site ↗
                  </a>
                ) : null}
              </div>
            </div>
            {canWrite ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-divider bg-canvas px-4 py-2">
                <Button size="sm" variant="primary" disabled={pending} onClick={() => setDialog({ kind: "update", group: bills })}>
                  Update status
                </Button>
                <Button size="sm" disabled={pending} onClick={() => calledNoChange(bills)} title={`Logs the call and books the next one in ${callEveryDays} days. The customer is not messaged.`}>
                  Called — no change
                </Button>
                {issue ? (
                  <Button size="sm" disabled={pending} onClick={() => run(() => erpLogisticsClearIssue(bills.map((b) => b.id), ""))}>
                    Problem solved
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDialog({ kind: "issue", group: bills })}>
                    Report a problem
                  </Button>
                )}
                <Button size="sm" className="ml-auto" disabled={pending} onClick={() => setDialog({ kind: "delivered", group: bills })}>
                  Delivered ✓
                </Button>
              </div>
            ) : null}
          </Card>
        );
      })}

      {dialog?.kind === "update" ? (
        <UpdateLrDialog key={`u${dialog.group[0].id}`} group={dialog.group} today={today} callEveryDays={callEveryDays} notifyOn={notifyOn} suggestions={suggestions ?? null} onClose={() => setDialog(null)} />
      ) : dialog ? (
        <ActionDialog key={`${dialog.kind}${dialog.group[0].id}`} dialog={{ kind: dialog.kind, group: dialog.group }} today={today} notifyOn={notifyOn} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

/** A problem, or the delivery — the two acts on the road that are not a status update (that one is `UpdateLrDialog`). */
function ActionDialog({ dialog, today, notifyOn, onClose }: { dialog: { kind: "issue" | "delivered"; group: Consignment[] }; today: string; notifyOn: boolean; onClose: () => void }) {
  const { run, pending } = useAct();
  const c = dialog.group[0];
  const ids = dialog.group.map((b) => b.id);
  const [note, setNote] = useState("");
  const [expected, setExpected] = useState(c.expectedDeliveryOn ?? "");
  const [issue, setIssue] = useState<string>("Delayed");
  /* What the customer's tracking page calls it: a delay reason, or nothing (the problem stays internal). */
  const [customerReason, setCustomerReason] = useState<string>(delayReasonForIssue("Delayed") ?? "");
  const [date, setDate] = useState(today);
  const [receivedBy, setReceivedBy] = useState("");
  const [proof, setProof] = useState("");
  const [notify, setNotify] = useState(true);

  const title = dialog.kind === "issue" ? `A problem with ${lrLabel(c.lrNo)}` : `${lrLabel(c.lrNo)} delivered`;
  const save = () => {
    const done = (r: { ok: boolean }) => r.ok && onClose();
    if (dialog.kind === "issue") return run(() => erpLogisticsIssue(ids, { issue, note, expectedOn: expected || null, notify, customerReason: customerReason || null }), done);
    return run(() => erpLogisticsDelivered(ids, { date, receivedBy, proof, note, notify }), done);
  };

  return (
    <ErpDialog onClose={onClose} label={title} size="sm" tall={false}>
      <DialogHeader onClose={onClose}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-3">
        <div className="text-sm text-body">
          {[...new Set(dialog.group.map((b) => b.deliveryParty))].join(", ")} · {plural(dialog.group.length, "bill")} · {c.transporter ?? "—"}
        </div>
        {dialog.kind === "issue" ? (
          <>
            <Field label="What went wrong?">
              <Select
                value={issue}
                onChange={(e) => {
                  setIssue(e.target.value);
                  setCustomerReason(delayReasonForIssue(e.target.value) ?? "");
                }}
              >
                {ISSUES.map((i) => (
                  <option key={i}>{i}</option>
                ))}
              </Select>
            </Field>
            <Field label="The customer's tracking page shows">
              <Select value={customerReason} onChange={(e) => setCustomerReason(e.target.value)}>
                <option value="">Nothing — keep it internal</option>
                {reasonsFor("delay")
                  .filter((r) => r.code !== "other")
                  .map((r) => (
                    <option key={r.code} value={r.code}>
                      Delivery Delayed · {r.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="New expected delivery (if the transporter gave one)">
              <Input type="date" value={expected} min={today} onChange={(e) => setExpected(e.target.value)} />
            </Field>
          </>
        ) : null}
        {dialog.kind === "delivered" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Received on">
              <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Received by">
              <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Who signed for it" />
            </Field>
            <div className="col-span-2">
              <Field label="Proof / reference">
                <Input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="POD number, signed copy, photo name — optional" />
              </Field>
            </div>
            <p className="col-span-2 text-meta text-muted">Close it only once the party has confirmed. Not confirmed yet? Report a problem — Unconfirmed — and it stays open.</p>
          </div>
        ) : null}
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
        <NotifyToggle value={notify} onChange={setNotify} disabled={!notifyOn} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={dialog.kind === "issue" ? "danger" : "primary"} disabled={pending || (dialog.kind === "issue" && issue === "Other" && !note.trim())} onClick={save}>
          {dialog.kind === "delivered" ? "Close as delivered" : "Record the problem"}
        </Button>
      </DialogFooter>
    </ErpDialog>
  );
}
