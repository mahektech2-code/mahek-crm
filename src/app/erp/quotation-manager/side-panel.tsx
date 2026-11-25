"use client";

import { useMemo } from "react";
import type { OpenRequirement } from "@/lib/erp/quotes";
import type { SheetCell, SheetColumn, SheetRow } from "@/lib/erp/engines/quote-sheet";
import { QUOTE_STATUS_SHORT, rateNumber } from "@/lib/erp/engines/quotes";
import { cheapestInMonth, latestByParty, packsFor, partyHistory } from "@/lib/erp/engines/quote-panel";
import { Button, cx } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { Eyebrow } from "../_ui/look";
import { MARK_DOT } from "./menus";
import { requirementLine } from "./purchase-dialog";
import { columnName, rateText, shortDate } from "./words";

/**
 * THE SIDE PANEL — what the desk wants to know about the selected rate before
 * it buys: the rate itself (and whether it is this month's cheapest), every
 * other party's latest rate for the same material, this party's recent quotes
 * for it, and the requirements waiting for it with a way to buy straight
 * away. Everything is read off the rows the table holds, through the pure
 * `quote-panel` engine the table's green and footer read too.
 */
export function SidePanel({
  rows,
  focus,
  waiting,
  unit,
  today,
  buy,
  othersRef,
  onJump,
  onPurchase,
}: {
  rows: SheetRow[];
  focus: { row: SheetRow; col: SheetColumn; cell: SheetCell | null } | null;
  waiting: OpenRequirement[];
  unit: string;
  today: string;
  /** Whether "Purchase it" may be pressed from here, and why not where it may not. */
  buy: { allowed: boolean; why?: string };
  othersRef: React.Ref<HTMLDivElement>;
  onJump: (rowId: string, columnId: string) => void;
  onPurchase: (reqId: string) => void;
}) {
  const col = focus?.col ?? null;
  const rate = col?.kind === "rate";
  const others = useMemo(() => (col && rate ? latestByParty(rows, col.id).slice(0, 6) : []), [rows, col, rate]);
  const history = useMemo(() => (col && rate && focus ? partyHistory(rows, col.id, focus.row.party, 6) : []), [rows, col, rate, focus]);

  if (!focus || !col) {
    return (
      <aside aria-label="Selected rate" className="hidden min-h-0 flex-col overflow-hidden rounded-t-card border border-b-0 border-line bg-surface xl:flex">
        <div className="px-4 py-4">
          <Eyebrow>Selected rate</Eyebrow>
          <p className="mt-2 text-sm text-muted">Select a rate to compare it with the other parties&rsquo; and buy it.</p>
        </div>
      </aside>
    );
  }

  const value = focus.cell?.value ?? "";
  const n = rate ? rateNumber(value) : null;
  const st = focus.cell?.status ?? null;
  const cheapMonth = n != null && st !== "cancel" && focus.row.status !== "cancel" && cheapestInMonth(rows, col.id, n, today);
  const top = history.reduce((m, h) => Math.max(m, h.rate), 0);
  const low = history.reduce((m, h) => Math.min(m, h.rate), Infinity);

  return (
    <aside aria-label="Selected rate" className="hidden min-h-0 flex-col overflow-y-auto rounded-t-card border border-b-0 border-line bg-surface xl:flex">
      <section className="border-b border-divider px-4 py-3.5">
        <Eyebrow>Selected rate</Eyebrow>
        <div className="mt-1 text-md font-semibold text-ink">{columnName(col)}</div>
        <div className="text-meta text-body">
          {focus.row.party || "No party"} · {shortDate(focus.row.date, today)}
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
          <span className="text-2xl font-bold text-ink tabular-nums">{value ? (rate ? rateText(value) : value) : "—"}</span>
          {rate && unit && value ? <span className="text-meta text-muted">per {unit}</span> : null}
          {cheapMonth ? <span className="text-meta font-semibold text-success">cheapest this month</span> : null}
        </div>
        {st ? (
          <div className="mt-1.5 text-meta text-body">
            <span aria-hidden className={cx("mr-1.5 inline-block h-2 w-2 rounded-full align-middle", MARK_DOT[st])} />
            {QUOTE_STATUS_SHORT[st]}
            {st === "po" && focus.cell?.poNo ? (
              <span className="text-muted">
                · <span className="font-mono text-ink">{focus.cell.poNo}</span>
                {focus.cell.drums ? ` · ${focus.cell.drums} drums` : ""}
                {focus.cell.poAt ? ` · ${stamp(focus.cell.poAt)}` : ""}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      {rate ? (
        <section ref={othersRef} className="border-b border-divider px-4 py-3.5">
          <Eyebrow>Others for this material</Eyebrow>
          {others.length ? (
            <ul className="mt-1">
              {others.map((o, i) => {
                const me = o.rowId === focus.row.id;
                return (
                  <li key={o.rowId} className="border-b border-dashed border-divider last:border-0">
                    <button
                      type="button"
                      onClick={() => onJump(o.rowId, col.id)}
                      className={cx("flex w-full cursor-pointer items-center gap-2 py-1.5 text-left text-meta hover:text-ink", me ? "text-ink" : "text-body")}
                      title="Go to this rate"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-semibold text-ink">{o.party}</span> · {shortDate(o.date, today)}
                      </span>
                      <span className={cx("tabular-nums", i === 0 && others.length > 1 ? "font-semibold text-success" : "", me && "underline underline-offset-2")}>
                        {rateText(o.value)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-1.5 text-meta text-muted">No rate in this column for the period shown.</p>
          )}
        </section>
      ) : null}

      {rate && history.length && focus.row.party ? (
        <section className="border-b border-divider px-4 py-3.5">
          <Eyebrow>
            {focus.row.party} — last {history.length === 1 ? "quote" : `${history.length} quotes`}
          </Eyebrow>
          <div className="mt-2 flex h-20 items-end gap-1.5">
            {history.map((h) => {
              /* The bars show the spread between this party's lowest and highest, not from zero —
                 a rupee's difference on ₹120 is what the desk is looking for. */
              const span = top - low;
              const height = span > 0 ? 8 + ((h.rate - low) / span) * 24 : 20;
              const me = h.rowId === focus.row.id;
              return (
                <button
                  key={h.rowId}
                  type="button"
                  onClick={() => onJump(h.rowId, col.id)}
                  title={`${rateText(h.value)} · ${shortDate(h.date, today)}`}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-0.5 text-2xs text-muted"
                >
                  <span className={cx("tabular-nums", me ? "font-semibold text-ink" : "")}>{Math.round(h.rate)}</span>
                  <span aria-hidden className={cx("block w-full rounded-[3px]", me ? "bg-brand" : "bg-line-strong")} style={{ height }} />
                  <span className="truncate">{shortDate(h.date, today)}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {rate && waiting.length && st !== "po" ? (
        <section className="grid gap-2.5 px-4 py-3.5">
          {waiting.map((r) => {
            const packs = packsFor(r.qty, r.unit, col.pack);
            return (
              <div key={r.id} className="grid gap-2 rounded-card border border-warn-line bg-warn-soft px-3 py-2.5 text-meta text-body">
                <span>
                  <span className="font-semibold text-ink">{r.reqNo ? `REQ-${r.reqNo}` : "A requirement"} is waiting for this</span>
                  <br />
                  {requirementLine(r).split(" · ").slice(1).join(" · ")}
                  {packs ? ` · about ${packs} drum${packs === 1 ? "" : "s"}` : ""}
                </span>
                {n != null ? (
                  <Button
                    size="sm"
                    variant="primary"
                    className="justify-self-start"
                    disabled={!buy.allowed}
                    title={buy.allowed ? undefined : buy.why}
                    onClick={() => onPurchase(r.id)}
                  >
                    Purchase it at {rateText(value)}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {!rate ? <p className="px-4 py-3.5 text-meta text-muted">This column holds text, so there is nothing to compare.</p> : null}
    </aside>
  );
}
