"use client";

import { cx, SectionLabel } from "@/components/ui/primitives";
import { registerPanel, type PanelProps } from "../panels";
import type { ScrapPanel } from "@/lib/erp/screens/scrap";

/* ---------------------------------------------------------------------------
 * An empty drum, a scrap sale, a vendor return, a receipt or a buyer's
 * ledger, in its drawer: the few figures that matter, then the history or
 * the lines behind them. The server says everything; this only draws it.
 * ------------------------------------------------------------------------- */

const TONE = { danger: "text-danger", success: "text-success", muted: "text-muted" } as const;

function Scrap({ data }: PanelProps) {
  const d = data as ScrapPanel;
  return (
    <section className="grid gap-3 rounded-[6px] border border-line p-3.5">
      {d.figures.length ? (
        <div className="grid grid-cols-3 gap-2">
          {d.figures.map((f) => (
            <div key={f.l} className="min-w-0 rounded-[4px] border border-divider px-3 py-2">
              <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{f.l}</div>
              <div className={cx("mt-0.5 text-base font-semibold tabular-nums", f.tone ? TONE[f.tone] : "text-ink")}>{f.v}</div>
            </div>
          ))}
        </div>
      ) : null}
      {d.sections.map((s) => (
        <div key={s.title} className="grid gap-1.5">
          <SectionLabel>{s.title}</SectionLabel>
          {s.lines.length ? (
            <ol className="grid gap-1.5">
              {s.lines.map((l, i) => (
                <li key={i} className="rounded-[4px] bg-canvas px-3 py-2">
                  <div className={cx("text-[13px]", l.tone ? TONE[l.tone] : "text-ink", l.tone === "muted" && "line-through")}>{l.text}</div>
                  {l.sub ? <div className="mt-0.5 text-xs text-muted">{l.sub}</div> : null}
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-[13px] text-muted">{s.empty ?? "Nothing yet."}</div>
          )}
        </div>
      ))}
      {d.note ? <div className="rounded-[4px] bg-info-soft px-3 py-2 text-[13px] text-info">{d.note}</div> : null}
    </section>
  );
}

registerPanel("scrap", Scrap);
