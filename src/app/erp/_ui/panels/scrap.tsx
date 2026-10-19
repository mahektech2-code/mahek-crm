"use client";

import { Callout, cx, SectionLabel } from "@/components/ui/primitives";
import { insetClass } from "../look";
import { registerPanel, type PanelProps } from "../panels";
import { Figure } from "./parts";
import type { ScrapPanel } from "@/lib/erp/screens/scrap";

/* ---------------------------------------------------------------------------
 * An empty drum, a scrap sale, a vendor return, a receipt or a buyer's
 * ledger, in its record: the few figures that matter, then the history or
 * the lines behind them. The server says everything; this only draws it.
 * ------------------------------------------------------------------------- */

const TONE = { danger: "text-danger", success: "text-success", muted: "text-muted" } as const;

function Scrap({ data }: PanelProps) {
  const d = data as ScrapPanel;
  return (
    <section className={cx("grid gap-3", insetClass)}>
      {d.figures.length ? (
        <div className="grid grid-cols-3 gap-2">
          {d.figures.map((f) => (
            <Figure key={f.l} l={f.l} v={f.v} tone={f.tone} />
          ))}
        </div>
      ) : null}
      {d.sections.map((s) => (
        <div key={s.title} className="grid gap-1.5">
          <SectionLabel>{s.title}</SectionLabel>
          {s.lines.length ? (
            <ol className="grid gap-1.5">
              {s.lines.map((l, i) => (
                <li key={i} className="rounded-control bg-canvas px-3 py-2">
                  <div className={cx("text-meta", l.tone ? TONE[l.tone] : "text-ink", l.tone === "muted" && "line-through")}>{l.text}</div>
                  {l.sub ? <div className="mt-0.5 text-xs text-muted">{l.sub}</div> : null}
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-meta text-muted">{s.empty ?? "Nothing yet."}</div>
          )}
        </div>
      ))}
      {d.note ? (
        <Callout tone="info" className="mb-0 block text-meta text-info">
          {d.note}
        </Callout>
      ) : null}
    </section>
  );
}

registerPanel("scrap", Scrap);
