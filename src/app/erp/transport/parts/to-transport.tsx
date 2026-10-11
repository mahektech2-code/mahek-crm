"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card, cx } from "@/components/ui/primitives";
import { erpLogisticsAtTransport, erpLogisticsDue, erpLogisticsPackages } from "@/lib/actions/erp-logistics";
import { addDays, shortDay } from "@/lib/erp/engines/logistics";
import type { Consignment } from "@/lib/erp/logistics";
import { BillRef, CallLink, DuePill, Empty, plural, sumLitres, sumPackages, useAct, useTicks } from "./common";

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
    <div className="space-y-4">
      {canWrite ? (
        <div className={cx("sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-[6px] border px-4 py-2.5", sel.length ? "border-brand bg-brand-soft" : "border-line bg-surface")}>
          <span className="mr-2 text-sm font-medium text-ink">{sel.length ? `${plural(sel.length, "bill")} ticked` : "Tick bills to plan them"}</span>
          <Button size="sm" disabled={!sel.length || pending} onClick={() => due(today)}>
            Reaches today
          </Button>
          <Button size="sm" disabled={!sel.length || pending} onClick={() => due(addDays(today, 1))}>
            Reaches tomorrow
          </Button>
          <span className="flex items-center gap-1">
            <input type="date" value={day} min={today} onChange={(e) => setDay(e.target.value)} className="h-8 rounded-[4px] border border-line bg-surface px-2 text-[13px]" />
            <Button size="sm" disabled={!sel.length || pending || !day} onClick={() => due(day)}>
              Set day
            </Button>
          </span>
          <span className="mx-1 h-5 w-px bg-line" />
          <Button size="sm" variant="primary" disabled={!sel.length || pending} onClick={() => reached(sel)}>
            Reached transporter
          </Button>
          {sel.length ? (
            <button className="ml-auto cursor-pointer text-[13px] text-muted hover:underline" onClick={clear}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {groups.map(([transporter, bills]) => {
        const ids = bills.map((b) => b.id);
        const all = ids.every((id) => ticked.has(id));
        const boxes = sumPackages(bills);
        const dueToday = bills.filter((b) => b.transportDueOn && b.transportDueOn <= today).length;
        return (
          <Card key={transporter} className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 border-b border-divider bg-canvas px-4 py-2.5">
              {canWrite ? <input type="checkbox" checked={all} onChange={() => setMany(ids, !all)} className="h-[15px] w-[15px] accent-[#6835FB]" aria-label={`Tick every bill for ${transporter}`} /> : null}
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-ink">{transporter}</div>
                <div className="text-[12px] text-muted">
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
            <div className="grid grid-cols-[28px_minmax(120px,1fr)_minmax(160px,1.6fr)_110px_96px_90px_130px] gap-3 border-b border-divider px-4 py-1.5 text-[12px] font-medium text-muted">
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
                {canWrite ? <input type="checkbox" checked={ticked.has(b.id)} onChange={() => toggle(b.id)} className="h-[15px] w-[15px] accent-[#6835FB]" aria-label={`Tick ${b.billNo ?? b.orderNo}`} /> : <span />}
                <span className="min-w-0">
                  <BillRef c={b} />
                  <span className="block truncate text-[12px] text-muted">Order {b.orderNo}{b.godown ? ` · ${b.godown}` : ""}</span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{b.deliveryParty}</span>
                  <span className="block truncate text-[12px] text-muted">{b.area ?? b.partyCity ?? "—"}{b.deliveryParty !== b.party ? ` · billed to ${b.party}` : ""}</span>
                </span>
                <span className="text-[13px] text-body">{b.billDate ? shortDay(b.billDate) : "—"}</span>
                <span>{canWrite ? <BoxInput id={b.id} value={b.packages} /> : (b.packages ?? "—")}</span>
                <span className="tabular-nums text-[13px]">{b.litres ?? "—"}</span>
                <span>{b.transportDueOn ? <DuePill day={b.transportDueOn} today={today} /> : <Badge tone="muted">Not planned</Badge>}</span>
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
    <input
      value={v}
      inputMode="numeric"
      disabled={pending}
      onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ""))}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="h-8 w-16 rounded-[4px] border border-line bg-surface px-2 text-sm tabular-nums outline-none focus:border-brand"
      aria-label="Boxes"
    />
  );
}
