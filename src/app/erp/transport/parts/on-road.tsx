"use client";

import Link from "next/link";
import { erpLink } from "@/lib/erp/registry";
import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { FilterPills } from "@/components/ui/overlays";
import { Badge, Button, Card, cx } from "@/components/ui/primitives";
import { erpLogisticsClearIssue, erpLogisticsDelivered, erpLogisticsIssue, erpLogisticsUpdate } from "@/lib/actions/erp-logistics";
import { addDays, callDue, daysBetween, ISSUES, ROAD_STAGES, runningLate, shortDay, STAGE_SHORT, trackingLink, type Stage } from "@/lib/erp/engines/logistics";
import type { Consignment } from "@/lib/erp/logistics";
import { BillRef, byLr, CallLink, DuePill, Empty, LrThumb, NotifyToggle, plural, StageStrip, sumPackages, useAct, lrLabel } from "./common";

/**
 * STEP 5 AND 6 — following the lorry. One card per LR (one LR is one
 * consignment), with the transporter's number to ring, where it is, when the
 * next call is owed and what was last said. An update that moves the stage is
 * shared with the customer; a problem can be raised, and the card closes when
 * the party has the goods.
 */
type Filter = "all" | "calls" | "late" | "issue";
type Dialog = { kind: "update" | "issue" | "delivered"; group: Consignment[] } | null;

export function OnRoad({ rows, today, callEveryDays, lateAfterDays, notifyOn, canWrite, initialFilter }: { rows: Consignment[]; today: string; callEveryDays: number; lateAfterDays: number; notifyOn: boolean; canWrite: boolean; initialFilter?: Filter }) {
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
    .filter((g) => !needle || g.bills.some((c) => [c.lrNo, c.billNo, c.party, c.deliveryParty, c.transporter, String(c.orderNo), c.area].some((x) => x?.toLowerCase().includes(needle))))
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
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search LR, bill, party, transporter" className="ml-auto h-8.5 w-[260px] rounded-control border border-line bg-surface px-2.5 text-sm outline-none focus:border-brand" />
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
                  <span className="font-mono text-md font-semibold text-ink">{lrLabel(c.lrNo)}</span>
                  <span className="text-meta text-body">· {c.transporter ?? "—"}</span>
                  {issue ? <Badge tone="danger">{issue.issue}</Badge> : null}
                  {late && !issue ? <Badge tone="warn">Running late</Badge> : null}
                  {waiting ? (
                    <Link href={erpLink("lrMessages")}>
                      <Badge tone="warn">{plural(waiting, "message")} to send</Badge>
                    </Link>
                  ) : null}
                </div>
                <div className="mt-0.5 text-sm font-medium text-ink">{parties.join(", ")}</div>
                <div className="text-xs text-muted">
                  {bills.map((b, i) => (
                    <span key={b.id}>
                      {i ? ", " : ""}
                      <BillRef c={b} />
                    </span>
                  ))}
                  {boxes != null ? ` · ${plural(boxes, "box", "boxes")}` : ""}
                  {c.area ? ` · ${c.area}` : ""}
                  {since ? ` · ${daysBetween(since, today)} d on the road` : ""}
                </div>
                {issue?.issueNote ? <div className="mt-1 text-xs text-danger">{issue.issueNote}</div> : null}
                {c.lastEventNote ? <div className="mt-1 truncate text-xs text-body">Last: {c.lastEventNote}</div> : null}
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
                  <a href={online} target="_blank" rel="noreferrer" className="block text-xs">
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

      {dialog ? <ActionDialog key={`${dialog.kind}${dialog.group[0].id}`} dialog={dialog} today={today} callEveryDays={callEveryDays} notifyOn={notifyOn} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function ActionDialog({ dialog, today, callEveryDays, notifyOn, onClose }: { dialog: NonNullable<Dialog>; today: string; callEveryDays: number; notifyOn: boolean; onClose: () => void }) {
  const { run, pending } = useAct();
  const c = dialog.group[0];
  const ids = dialog.group.map((b) => b.id);
  const [stage, setStage] = useState<string>(ROAD_STAGES.includes(c.stage as Stage) ? c.stage : "In Transit");
  const [note, setNote] = useState("");
  const [expected, setExpected] = useState(c.expectedDeliveryOn ?? "");
  const [nextCall, setNextCall] = useState(addDays(today, callEveryDays));
  const [issue, setIssue] = useState<string>("Delayed");
  const [date, setDate] = useState(today);
  const [receivedBy, setReceivedBy] = useState("");
  const [notify, setNotify] = useState(true);
  const cls = "mt-0.5 block h-8.5 w-full rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand";

  const title = dialog.kind === "update" ? `Update ${lrLabel(c.lrNo)}` : dialog.kind === "issue" ? `A problem with ${lrLabel(c.lrNo)}` : `${lrLabel(c.lrNo)} delivered`;
  const save = () => {
    const done = (r: { ok: boolean }) => r.ok && onClose();
    if (dialog.kind === "update") return run(() => erpLogisticsUpdate(ids, { stage, note, expectedOn: expected || null, nextCallOn: nextCall || null, notify }), done);
    if (dialog.kind === "issue") return run(() => erpLogisticsIssue(ids, { issue, note, expectedOn: expected || null, notify }), done);
    return run(() => erpLogisticsDelivered(ids, { date, receivedBy, note, notify }), done);
  };
  const moved = dialog.kind === "update" && (stage !== c.stage || (expected && expected !== c.expectedDeliveryOn));

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={dialog.kind === "issue" ? "danger" : "primary"} disabled={pending || (dialog.kind === "issue" && issue === "Other" && !note.trim())} onClick={save}>
            {dialog.kind === "delivered" ? "Close as delivered" : dialog.kind === "issue" ? "Record the problem" : "Save update"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-xs text-muted">
        <div className="text-sm text-body">
          {[...new Set(dialog.group.map((b) => b.deliveryParty))].join(", ")} · {plural(dialog.group.length, "bill")} · {c.transporter ?? "—"}
        </div>
        {dialog.kind === "update" ? (
          <>
            <div>
              Where are the goods?
              <div className="mt-1 grid grid-cols-3 gap-2">
                {ROAD_STAGES.map((s) => (
                  <button key={s} type="button" onClick={() => setStage(s)} className={cx("cursor-pointer rounded-control border px-2 py-2 text-meta", stage === s ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line bg-surface text-body hover:bg-canvas")}>
                    {STAGE_SHORT[s]}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label>Expected delivery<input type="date" value={expected} min={today} onChange={(e) => setExpected(e.target.value)} className={cls} /></label>
              <label>Next call to the transporter<input type="date" value={nextCall} min={today} onChange={(e) => setNextCall(e.target.value)} className={cls} /></label>
            </div>
          </>
        ) : null}
        {dialog.kind === "issue" ? (
          <>
            <label>
              What went wrong?
              <select value={issue} onChange={(e) => setIssue(e.target.value)} className={cls}>
                {ISSUES.map((i) => (
                  <option key={i}>{i}</option>
                ))}
              </select>
            </label>
            <label>New expected delivery (if the transporter gave one)<input type="date" value={expected} min={today} onChange={(e) => setExpected(e.target.value)} className={cls} /></label>
          </>
        ) : null}
        {dialog.kind === "delivered" ? (
          <div className="grid grid-cols-2 gap-3">
            <label>Received on<input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={cls} /></label>
            <label>Received by<input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Who signed for it" className={cls} /></label>
          </div>
        ) : null}
        <label>
          {dialog.kind === "update" ? "What the transporter said" : "Note"}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mt-0.5 block w-full rounded-control border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand" />
        </label>
        {dialog.kind === "update" && !moved ? <div className="text-xs text-muted">The stage and the date have not moved, so this is logged as a call and the customer is not messaged.</div> : null}
        {dialog.kind !== "update" || moved ? <NotifyToggle value={notify} onChange={setNotify} disabled={!notifyOn} /> : null}
      </div>
    </Modal>
  );
}
