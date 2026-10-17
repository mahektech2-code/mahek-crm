"use client";

import { useState } from "react";
import { customKey, customRange, PERIODS } from "@/lib/erp/period";

/**
 * The period a register is read through (`lib/erp/period.ts`). A preset is
 * one pick; a range opens two date boxes and is applied as one step, so the
 * list is not re-read on every keystroke of a date.
 */
export function PeriodPicker({ pd, label, dateLabel, onPick }: { pd: string; label: string; dateLabel: string; onPick: (pd: string) => void }) {
  const custom = customRange(pd);
  const [open, setOpen] = useState(!!custom);
  const [from, setFrom] = useState(custom?.from ?? "");
  const [to, setTo] = useState(custom?.to ?? "");
  const box = "h-8 rounded-control border border-line bg-surface px-2.5 text-meta text-body outline-none focus:border-brand";
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={custom || open ? "custom" : pd}
        onChange={(e) => {
          if (e.target.value === "custom") setOpen(true);
          else {
            setOpen(false);
            onPick(e.target.value);
          }
        }}
        aria-label={`${dateLabel} period`}
        title={`${dateLabel}: ${label}`}
        className={`${box} cursor-pointer`}
      >
        {PERIODS.map((p) => (
          <option key={p.k} value={p.k}>
            {p.l}
          </option>
        ))}
        <option value="custom">{custom ? label : "Custom range…"}</option>
      </select>
      {open ? (
        <>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" className={box} />
          <span className="text-meta text-muted">to</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" className={box} />
          <button
            type="button"
            disabled={!from && !to}
            onClick={() => onPick(customKey({ from: from || null, to: to || null }))}
            className="h-8 cursor-pointer rounded-control border border-brand bg-brand-soft px-2.5 text-meta font-medium text-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply
          </button>
        </>
      ) : null}
    </div>
  );
}
