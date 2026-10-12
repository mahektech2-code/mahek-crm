"use client";

import Link from "next/link";
import { erpLink } from "@/lib/erp/registry";
import { CardGrid } from "@/components/ui/card-grid";
import { Badge, Button, Card, cx } from "@/components/ui/primitives";
import { erpLogisticsReopen } from "@/lib/actions/erp-logistics";
import { callDue, daysBetween, runningLate, shortDay } from "@/lib/erp/engines/logistics";
import type { Consignment } from "@/lib/erp/logistics";
import { BillRef, byLr, CallLink, DuePill, Empty, plural, ReasonDialog, StageStrip, sumPackages, useAct, lrLabel } from "./common";
import { useState } from "react";

/**
 * THE DAY ON ONE SCREEN. The four steps of the flow as a pipeline — each a
 * count and a link to its tab — then the calls owed today and what needs
 * somebody's attention: a problem on the road, a lorry running late, a bill
 * sitting at the transporter with no LR, a message nobody has sent.
 */
export function Overview({
  rows,
  lrsWaiting,
  messagesWaiting,
  today,
  lateAfterDays,
}: {
  rows: Consignment[];
  lrsWaiting: number;
  messagesWaiting: number;
  today: string;
  lateAfterDays: number;
}) {
  const toT = rows.filter((c) => c.phase === "toTransport");
  const lrP = rows.filter((c) => c.phase === "lrPending");
  const road = rows.filter((c) => c.phase === "onRoad");
  const roadGroups = byLr(road);
  const doneWeek = rows.filter((c) => c.phase === "delivered" && c.deliveredOn && daysBetween(c.deliveredOn, today) < 7);
  const calls = roadGroups.filter((g) => g.bills.some((c) => callDue({ reminderDate: c.nextCallOn, materialStage: c.stage }, today)));
  const issues = roadGroups.filter((g) => g.bills.some((c) => c.issue));
  const late = roadGroups.filter((g) => !g.bills.some((c) => c.issue) && g.bills.some((c) => runningLate({ expectedDeliveryOn: c.expectedDeliveryOn, billDate: c.billDate, materialStage: c.stage }, today, lateAfterDays)));
  const stuck = lrP.filter((c) => c.atTransportAt && daysBetween(c.atTransportAt.slice(0, 10), today) >= 2);
  const dueToday = toT.filter((c) => c.transportDueOn && c.transportDueOn <= today);

  const steps = [
    { n: "1", l: "Going to the transporter", v: toT.length, sub: dueToday.length ? `${dueToday.length} due today or late` : `${sumPackages(toT) ?? "—"} boxes`, href: erpLink("toTransport"), tone: dueToday.length ? "warn" : undefined },
    { n: "2", l: "Waiting for the LR", v: lrP.length, sub: lrsWaiting ? `${plural(lrsWaiting, "LR")} uploaded to attach` : "No LR uploaded yet", href: erpLink("pendingLr"), tone: lrsWaiting ? "brand" : undefined },
    { n: "3", l: "On the road", v: roadGroups.length, sub: `${plural(road.length, "bill")} · ${calls.length} call${calls.length === 1 ? "" : "s"} due`, href: erpLink("trackLr"), tone: calls.length ? "warn" : undefined },
    { n: "4", l: "Delivered this week", v: doneWeek.length, sub: "bills received by the party", href: erpLink("delivered"), tone: "success" },
  ] as const;

  return (
    <div className="space-y-4">
      <CardGrid min={200} gap="gap-3">
        {steps.map((s, i) => (
          <Link key={s.n} href={s.href} className="group relative no-underline hover:no-underline">
            <Card className={cx("h-full px-4 py-3 transition-colors group-hover:border-brand", s.tone === "warn" && "border-warn/60", s.tone === "brand" && "border-brand/50")}>
              <div className="flex items-center gap-2 text-xs font-medium text-muted">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-canvas text-2xs text-body">{s.n}</span>
                {s.l}
              </div>
              <div className="mt-1 text-[28px] leading-8 font-semibold text-ink tabular-nums">{s.v}</div>
              <div className={cx("text-xs", s.tone === "warn" ? "text-warn-ink" : s.tone === "brand" ? "text-brand-hover" : "text-muted")}>{s.sub}</div>
            </Card>
            {i < steps.length - 1 ? <span className="absolute top-1/2 -right-3 z-1 hidden -translate-y-1/2 text-muted xl:block">›</span> : null}
          </Link>
        ))}
      </CardGrid>

      <CardGrid min={380} className="items-start">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-divider px-4 py-3">
            <div>
              <div className="text-md font-semibold text-ink">Calls to make today</div>
              <div className="text-xs text-muted">Ring the transporter, then update the LR on the road.</div>
            </div>
            <Link href={erpLink("trackLr", { filter: "calls" })}>
              <Button size="sm">Open</Button>
            </Link>
          </div>
          {calls.length ? (
            calls.slice(0, 12).map((g) => {
              const c = g.bills[0];
              return (
                <div key={g.key} className="flex items-center gap-3 border-b border-divider px-4 py-2.5 text-sm last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink">
                      {lrLabel(c.lrNo)} · {c.deliveryParty}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {c.transporter ?? "—"} · {c.lastEventNote ?? "no update yet"}
                    </div>
                  </div>
                  <StageStrip stage={c.stage} compact />
                  <DuePill day={c.nextCallOn} today={today} />
                  <CallLink phone={c.transporterPhone} name={c.transporter} />
                </div>
              );
            })
          ) : (
            <Empty>No call is owed today.</Empty>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-divider px-4 py-3">
            <div className="text-md font-semibold text-ink">Needs attention</div>
            <div className="text-xs text-muted">Everything that is not moving the way it should.</div>
          </div>
          <Attention label="Problems on the road" tone="danger" href={erpLink("trackLr", { filter: "issue" })} items={issues.map((g) => ({ key: g.key, main: `${lrLabel(g.bills[0].lrNo)} · ${g.bills[0].deliveryParty}`, sub: `${g.bills.find((b) => b.issue)?.issue}${g.bills.find((b) => b.issue)?.issueNote ? ` — ${g.bills.find((b) => b.issue)?.issueNote}` : ""}` }))} />
          <Attention label="Running late" tone="warn" href={erpLink("trackLr", { filter: "late" })} items={late.map((g) => ({ key: g.key, main: `${lrLabel(g.bills[0].lrNo)} · ${g.bills[0].deliveryParty}`, sub: g.bills[0].expectedDeliveryOn ? `Expected ${shortDay(g.bills[0].expectedDeliveryOn)}` : `${daysBetween(g.bills[0].billDate ?? today, today)} days since dispatch` }))} />
          <Attention label="At the transporter 2+ days with no LR" tone="warn" href={erpLink("pendingLr")} items={stuck.map((c) => ({ key: c.id, main: `${c.billNo ?? `Order ${c.orderNo}`} · ${c.deliveryParty}`, sub: `${c.transporter ?? "—"} since ${shortDay(c.atTransportAt!.slice(0, 10))}` }))} />
          <Attention label="Customer messages to send by hand" tone="warn" href={erpLink("lrMessages")} items={messagesWaiting ? [{ key: "m", main: plural(messagesWaiting, "message"), sub: "Open WhatsApp from the Customer messages tab and mark each sent." }] : []} />
          {!issues.length && !late.length && !stuck.length && !messagesWaiting ? <Empty>Nothing needs attention.</Empty> : null}
        </Card>
      </CardGrid>
    </div>
  );
}

function Attention({ label, tone, href, items }: { label: string; tone: "danger" | "warn"; href: string; items: { key: string; main: string; sub: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="border-b border-divider px-4 py-2.5 last:border-0">
      <Link href={href} className="flex items-center gap-2 text-meta font-medium text-ink no-underline">
        <Badge tone={tone}>{items.length}</Badge> {label} ›
      </Link>
      <div className="mt-1 space-y-0.5">
        {items.slice(0, 4).map((i) => (
          <div key={i.key} className="truncate text-xs">
            <span className="text-body">{i.main}</span> <span className="text-muted">· {i.sub}</span>
          </div>
        ))}
        {items.length > 4 ? <div className="text-xs text-muted">and {items.length - 4} more</div> : null}
      </div>
    </div>
  );
}

/** Closed in the last weeks: how long each took, who signed, and the way back for a mistake. */
export function Delivered({ rows, canWrite }: { rows: Consignment[]; canWrite: boolean }) {
  const { run, pending } = useAct();
  const [reopen, setReopen] = useState<Consignment | null>(null);
  const sorted = [...rows].sort((a, b) => (b.deliveredOn ?? "").localeCompare(a.deliveredOn ?? ""));
  const took = sorted.filter((c) => c.deliveredOn && c.billDate).map((c) => daysBetween(c.billDate!, c.deliveredOn!));
  const avg = took.length ? Math.round((took.reduce((a, b) => a + b, 0) / took.length) * 10) / 10 : null;
  return (
    <div className="space-y-3">
      <div className="text-meta text-muted">
        {plural(sorted.length, "bill")} delivered in the last 45 days{avg != null ? ` · ${avg} days from dispatch to delivery on average` : ""}.
      </div>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-[minmax(110px,1fr)_minmax(150px,1.5fr)_minmax(110px,1fr)_minmax(110px,1fr)_96px_96px_70px_minmax(100px,1fr)_70px] gap-3 border-b border-divider bg-canvas px-4 py-2 text-xs font-medium text-muted">
          <span>Bill</span>
          <span>Party</span>
          <span>LR</span>
          <span>Transporter</span>
          <span>Left</span>
          <span>Delivered</span>
          <span>Days</span>
          <span>Received by</span>
          <span />
        </div>
        {sorted.length ? (
          sorted.map((c) => (
            <div key={c.id} className="grid grid-cols-[minmax(110px,1fr)_minmax(150px,1.5fr)_minmax(110px,1fr)_minmax(110px,1fr)_96px_96px_70px_minmax(100px,1fr)_70px] items-center gap-3 border-b border-divider px-4 py-2 text-sm last:border-0">
              <BillRef c={c} />
              <span className="truncate">{c.deliveryParty}</span>
              <span className="truncate font-mono text-meta">{c.lrNo ?? "—"}</span>
              <span className="truncate text-meta">{c.transporter ?? "—"}</span>
              <span className="text-meta">{c.billDate ? shortDay(c.billDate) : "—"}</span>
              <span className="text-meta">{c.deliveredOn ? shortDay(c.deliveredOn) : "—"}</span>
              <span className="tabular-nums">{c.deliveredOn && c.billDate ? daysBetween(c.billDate, c.deliveredOn) : "—"}</span>
              <span className="truncate text-meta">{c.receivedBy ?? "—"}</span>
              <span className="text-right">
                {canWrite ? (
                  <button className="cursor-pointer text-xs text-muted hover:underline" onClick={() => setReopen(c)}>
                    Reopen
                  </button>
                ) : null}
              </span>
            </div>
          ))
        ) : (
          <Empty>Nothing delivered in the last 45 days.</Empty>
        )}
      </Card>
      <ReasonDialog
        key={reopen?.id ?? ""}
        open={!!reopen}
        title={reopen ? `Reopen ${reopen.billNo ?? `order ${reopen.orderNo}`}?` : ""}
        body="It goes back on the road with a call due today. The customer is not messaged."
        placeholder="Why — e.g. closed by mistake, party says not received"
        keepLabel="Keep it closed"
        confirmLabel="Reopen"
        pending={pending}
        onClose={() => setReopen(null)}
        onConfirm={(reason) => reopen && run(() => erpLogisticsReopen(reopen.id, reason), (r) => r.ok && setReopen(null))}
      />
    </div>
  );
}
