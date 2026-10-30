"use client";

/* ---------------------------------------------------------------------------
 * SHOPS THESE RULES WOULD PUT ON A SECOND LIST — and the one question asked
 * of each: which list keeps it.
 *
 * "Keep where it is" leaves the shop out of THIS list; its prices do not
 * change. "Move here" takes it off the list it is on, and this list prices it
 * from the day it starts. Every answer is written the moment it is given (as a
 * leave-out row, or a move), so the box shrinks as the answers come in and
 * Publish unlocks when it is empty. Standard never appears here: it is the
 * floor under everybody, not a second list.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Button } from "@/components/ui/primitives";
import type { ClashView } from "@/lib/services/price-one-list-service";

export function ClashBox({
  clashes,
  enforced,
  onKeep,
  onMove,
  busy,
}: {
  clashes: ClashView[];
  enforced: boolean;
  onKeep: (shops: ClashView[]) => void;
  onMove: (shops: ClashView[]) => void;
  busy?: boolean;
}) {
  if (!clashes.length) return null;
  const shown = clashes.slice(0, 60);
  const byList = new Map<string, number>();
  for (const c of clashes) for (const o of c.others) byList.set(o.listName, (byList.get(o.listName) ?? 0) + 1);
  const n = clashes.length;
  return (
    <div className={enforced ? "rounded-[8px] border border-danger bg-danger-soft p-3.5" : "rounded-[8px] border border-warn-line bg-warn-soft p-3.5"}>
      <div className="text-sm font-semibold text-danger">
        {n} of these shop{n === 1 ? " already has" : "s already have"} a price list
      </div>
      <p className="mt-0.5 text-[13px] text-body">
        {enforced
          ? "A shop can be on one list. Say which list keeps each one; nothing is published until every shop has one answer."
          : "The one-list rule is switched off, so these shops would be on two lists and the narrower one prices them."}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onKeep(clashes)}>
          Keep all {n} where they are
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onMove(clashes)}>
          Move all {n} to this list
        </Button>
        <span className="text-[12px] text-muted">
          {[...byList.entries()].map(([name, count]) => `${name} ${count}`).join(" · ")}
        </span>
      </div>
      <div className="mt-2.5 max-h-[300px] overflow-auto rounded-[6px] border border-line bg-surface">
        <table className="w-full table-fixed text-[13px]">
          <colgroup>
            <col />
            <col style={{ width: 170 }} />
            <col style={{ width: 230 }} />
          </colgroup>
          <thead>
            <tr className="border-b border-line bg-canvas text-left text-[11px] tracking-[0.06em] text-muted uppercase">
              <th className="px-2.5 py-1.5 font-semibold">Shop</th>
              <th className="px-2.5 py-1.5 font-semibold">On today</th>
              <th className="px-2.5 py-1.5 font-semibold">Which list keeps it</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.customerId} className="border-b border-divider last:border-0">
                <td className="truncate px-2.5 py-1.5" title={c.name}>
                  <span className="font-medium text-ink">{c.name}</span>
                  {c.city ? <span className="text-muted"> · {c.city}</span> : null}
                </td>
                <td className="truncate px-2.5 py-1.5" title={c.others.map((o) => o.listName).join(", ")}>
                  {c.others.map((o) => o.listName).join(", ")}
                </td>
                <td className="px-2.5 py-1.5">
                  <button type="button" disabled={busy} className="mr-3 cursor-pointer text-brand hover:underline" onClick={() => onKeep([c])}>
                    Keep where it is
                  </button>
                  <button type="button" disabled={busy} className="cursor-pointer text-brand hover:underline" onClick={() => onMove([c])}>
                    Move here
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {n > shown.length ? (
          <p className="border-t border-divider px-2.5 py-1.5 text-[12px] text-muted">
            … and {n - shown.length} more. The buttons above answer every one of them.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The three numbers above the rules: reached, left out, priced. */
export function ReachStrip({
  reached,
  leftOut,
  priced,
  clashes,
  loading,
}: {
  reached: number;
  leftOut: number;
  priced: number;
  clashes: number;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[8px] border border-brand-soft bg-brand-soft px-3.5 py-2.5">
      <Figure value={reached} label="shops these rules reach" />
      <Figure value={leftOut ? -leftOut : 0} label="left out by name or place" tone={leftOut ? "danger" : undefined} />
      <Figure value={priced} label="priced from this list" tone="ok" />
      <span className="ml-auto text-[12px]">
        {loading ? (
          <span className="text-muted">Counting…</span>
        ) : clashes ? (
          <span className="font-semibold text-danger">
            {clashes} shop{clashes === 1 ? "" : "s"} to decide
          </span>
        ) : (
          <span className="font-semibold text-success">✓ No shop is on another list</span>
        )}
      </span>
    </div>
  );
}

function Figure({ value, label, tone }: { value: number; label: string; tone?: "danger" | "ok" }) {
  return (
    <div>
      <div className={tone === "danger" ? "text-lg font-bold text-danger" : tone === "ok" ? "text-lg font-bold text-success" : "text-lg font-bold text-ink"}>
        {value.toLocaleString("en-IN")}
      </div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}
