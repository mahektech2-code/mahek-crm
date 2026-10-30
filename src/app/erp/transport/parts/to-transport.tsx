"use client";

import { useMemo, useState } from "react";
import { Button, Card, checkboxClass, controlClass, cx } from "@/components/ui/primitives";
import { Badge } from "../../_ui/badge";
import { gridHeadClass, LinkButton, SubTitle } from "../../_ui/look";
import { erpLogisticsAtTransport, erpLogisticsDeliveredBy, erpLogisticsDue, erpLogisticsPackages } from "@/lib/actions/erp-logistics";
import { addDays, MAHEK_VEHICLE, shortDay } from "@/lib/erp/engines/logistics";
import type { Consignment } from "@/lib/erp/logistics";
import { BillRef, CallLink, DuePill, Empty, plural, sumLitres, sumPackages, useAct, useTicks, vehicleWords } from "./common";
import { cleanWhole } from "@/lib/format";

/**
 * STEP 1 AND 2. Bills that have left the factory and are on their way to the
 * transporter's godown at Bhiwandi, grouped by transporter — the way the team
 * follows them, one call per transporter. Say when each will reach (today,
 * tomorrow, a day), confirm the box count, and mark it reached when the
 * transporter has it; it then waits for its LR on the LR desk.
 */
export function ToTransport({ rows, today, canWrite }: { rows: Consignment[]; today: string; canWrite: boolean }) {
  const { run, pending } = useAct();
  const { ticked, toggle, setMany, clear } = useTicks();
  const [day, setDay] = useState(addDays(today, 2));

  const groups = useMemo(() => {
    const m = new Map<string, Consignment[]>();
    for (const r of rows) m.set(r.transporter ?? "No transporter named", [...(m.get(r.transporter ?? "No transporter named") ?? []), r]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [rows]);

  const sel = [...ticked].filter((id) => rows.some((r) => r.id === id));
  const due = (d: string) => run(() => erpLogisticsDue(sel, d), (r) => r.ok && clear());
  const reached = (ids: string[]) => run(() => erpLogisticsAtTransport(ids), (r) => r.ok && clear());

  if (!rows.length) return <Card><Empty>Nothing is on its way to a transporter. A bill appears here the moment it is dispatch-verified.</Empty></Card>;

  return (
    <div className="space-y-5">
      {canWrite ? (
        <div className={cx("sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-card border px-4 py-2.5", sel.length ? "border-brand bg-brand-soft" : "border-line bg-surface")}>
          <span className="mr-2 text-sm font-medium text-ink">{sel.length ? `${plural(sel.length, "bill")} ticked` : "Tick bills to plan them"}</span>
          <Button size="sm" disabled={!sel.length || pending} onClick={() => due(today)}>
            Reaches today
          </Button>
          <Button size="sm" disabled={!sel.length || pending} onClick={() => due(addDays(today, 1))}>
            Reaches tomorrow
          </Button>
          <span className="flex items-center gap-1">
            <span className="w-36">
              <input type="date" value={day} min={today} onChange={(e) => setDay(e.target.value)} className={controlClass({ className: "h-8.5" })} />
            </span>
            <Button size="sm" disabled={!sel.length || pending || !day} onClick={() => due(day)}>
              Set day
            </Button>
          </span>
          <span className="mx-1 h-5 w-px bg-line" />
          <Button size="sm" variant="primary" disabled={!sel.length || pending} onClick={() => reached(sel)}>
            Reached transporter
          </Button>
          <Button size="sm" variant="ghost" disabled={!sel.length || pending} onClick={() => run(() => erpLogisticsDeliveredBy(sel, MAHEK_VEHICLE), (r) => r.ok && clear())} title="These go in our own vehicle instead — no LR; the customer-signed copy closes them">
            Send in a Mahek Vehicle
          </Button>
          {sel.length ? (
            <LinkButton tone="muted" className="ml-auto text-meta" onClick={clear}>
              Clear
            </LinkButton>
          ) : null}
        </div>
      ) : null}

      {groups.map(([transporter, bills]) => {
        const ids = bills.map((b) => b.id);
        const all = ids.every((id) => ticked.has(id));
        const boxes = sumPackages(bills);
        const dueToday = bills.filter((b) => b.transportDueOn && b.transportDueOn <= today).length;
        return (
          <Card key={transporter} className="overflow-clip">
            <div className="flex flex-wrap items-center gap-3 border-b border-divider bg-canvas px-4 py-2.5">
              {canWrite ? <input type="checkbox" checked={all} onChange={() => setMany(ids, !all)} className={checkboxClass} aria-label={`Tick every bill for ${transporter}`} /> : null}
              <div className="min-w-0">
                <SubTitle className="mb-0">{transporter}</SubTitle>
                <div className="text-meta text-muted">
                  {plural(bills.length, "bill")} · {boxes != null ? plural(boxes, "box", "boxes") : "boxes not counted"} · {sumLitres(bills)} L{dueToday ? ` · ${dueToday} due today or late` : ""}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <CallLink phone={bills[0].transporterPhone} name={bills[0].transporter} />
                {canWrite ? (
                  <Button size="sm" disabled={pending} onClick={() => reached(ids)}>
                    All reached
                  </Button>
                ) : null}
              </div>
            </div>
            <div className={cx("grid grid-cols-[28px_minmax(120px,1fr)_minmax(160px,1.6fr)_110px_96px_90px_130px] gap-3 px-4 py-1.5", gridHeadClass)}>
              <span />
              <span>Bill</span>
              <span>Goes to</span>
              <span>Left factory</span>
              <span>Boxes</span>
              <span>Litres</span>
              <span>Reaches transporter</span>
            </div>
            {bills.map((b) => (
              <div key={b.id} className={cx("grid grid-cols-[28px_minmax(120px,1fr)_minmax(160px,1.6fr)_110px_96px_90px_130px] items-center gap-3 border-b border-divider px-4 py-2 text-sm last:border-0", ticked.has(b.id) && "bg-brand-soft/40")}>
                {canWrite ? <input type="checkbox" checked={ticked.has(b.id)} onChange={() => toggle(b.id)} className={checkboxClass} aria-label={`Tick ${b.billNo ?? b.orderNo}`} /> : <span />}
                <span className="min-w-0">
                  <BillRef c={b} />
                  <span className="block truncate text-meta text-muted">Order {b.orderNo}{b.godown ? ` · ${b.godown}` : ""}</span>
                  <span className={cx("block truncate text-2xs", b.vehicleNo ? "text-muted" : "text-warn")}>{vehicleWords(b)}</span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{b.deliveryParty}</span>
                  <span className="block truncate text-meta text-muted">{b.area ?? b.partyCity ?? "—"}{b.deliveryParty !== b.party ? ` · billed to ${b.party}` : ""}</span>
                </span>
                <span className="text-meta text-body">{b.billDate ? shortDay(b.billDate) : "—"}</span>
                <span>{canWrite ? <BoxInput id={b.id} value={b.packages} /> : (b.packages ?? "—")}</span>
                <span className="tabular-nums text-meta">{b.litres ?? "—"}</span>
                <span>{b.transportDueOn ? <DuePill day={b.transportDueOn} today={today} /> : <Badge label="Not planned" tone="muted" />}</span>
              </div>
            ))}
          </Card>
        );
      })}
    </div>
  );
}

/** The box count, saved when the person leaves the box. */
export function BoxInput({ id, value }: { id: string; value: number | null }) {
  const { run, pending } = useAct();
  const [v, setV] = useState(value == null ? "" : String(value));
  const save = () => {
    const n = v.trim() === "" ? null : Number(v);
    if (n === value || (n != null && !Number.isFinite(n))) return;
    void run(() => erpLogisticsPackages(id, n));
  };
  return (
    <span className="block w-16">
      <input
      value={v}
      inputMode="numeric"
      disabled={pending}
      onChange={(e) => setV(cleanWhole(e.target.value))}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={controlClass({ className: "h-8.5 tabular-nums" })}
      aria-label="Boxes"
      />
    </span>
  );
}
