"use client";

import Link from "next/link";
import type { SummaryCard } from "@/lib/erp/ui";
import { Card, cx, Dot } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { Icon } from "@/components/shell/icons";
import { crmTone } from "./badge";

/* ---------------------------------------------------------------------------
 * The cards a list can carry above it — the dashboard's tile rows, so the
 * Petty cash overview reads the way the ERP's own dashboard does: a headline
 * figure, the figures under it, every one opening the records it counts.
 * ------------------------------------------------------------------------- */

const TEXT: Record<string, string> = { danger: "text-danger", success: "text-success", warn: "text-warn" };

export function SummaryCards({ cards }: { cards: SummaryCard[] }) {
  return (
    <CardGrid min={280} className="mb-4">
      {cards.map((c) => (
        <Card key={c.t} className="overflow-hidden">
          <div className="border-b border-divider px-5 py-3.5">
            <div className="text-[15px] font-semibold text-ink">{c.t}</div>
            {c.sub ? <div className="mt-0.5 text-xs text-muted">{c.sub}</div> : null}
            {c.big ? (
              <div className="mt-2">
                <div className={cx("text-2xl leading-8 font-semibold tabular-nums", TEXT[c.big.tone ?? ""] ?? "text-ink")}>{c.big.v}</div>
                {c.big.sub ? <div className="text-xs text-muted">{c.big.sub}</div> : null}
              </div>
            ) : null}
          </div>
          {c.rows.map((r) => {
            const body = (
              <>
                <Dot tone={crmTone(r.tone)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink">{r.l}</span>
                  {r.sub ? <span className="mt-px block text-xs text-muted">{r.sub}</span> : null}
                </span>
                <span className={cx("text-[15px] font-semibold whitespace-nowrap tabular-nums", TEXT[r.tone ?? ""] ?? "text-ink")}>{r.v}</span>
                {r.href ? <Icon name="chevron" size={14} className="flex-none text-line-strong" /> : <span className="w-3.5" />}
              </>
            );
            return r.href ? (
              <Link key={r.l} href={r.href} className="flex w-full items-center gap-3 border-b border-divider px-5 py-2.5 text-left no-underline last:border-0 hover:bg-canvas hover:no-underline">
                {body}
              </Link>
            ) : (
              <div key={r.l} className="flex w-full items-center gap-3 border-b border-divider px-5 py-2.5 last:border-0">
                {body}
              </div>
            );
          })}
        </Card>
      ))}
    </CardGrid>
  );
}
