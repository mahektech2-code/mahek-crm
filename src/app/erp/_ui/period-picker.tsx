"use client";

import { useState } from "react";
import { customKey, customRange, PERIODS } from "@/lib/erp/period";
import { Button, Input, Select } from "@/components/ui/primitives";

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
  return (
    <div className="flex items-center gap-1.5">
      <Select
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
        className="cursor-pointer"
      >
        {PERIODS.map((p) => (
          <option key={p.k} value={p.k}>
            {p.l}
          </option>
        ))}
        <option value="custom">{custom ? label : "Custom range…"}</option>
      </Select>
      {open ? (
        <>
          <span className="w-38 flex-none">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          </span>
          <span className="text-meta text-muted">to</span>
          <span className="w-38 flex-none">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </span>
          <Button type="button" variant="primary" size="sm" disabled={!from && !to} onClick={() => onPick(customKey({ from: from || null, to: to || null }))}>
            Apply
          </Button>
        </>
      ) : null}
    </div>
  );
}
