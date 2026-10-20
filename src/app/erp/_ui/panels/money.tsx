"use client";

import { Callout, cx, SectionLabel } from "@/components/ui/primitives";
import { insetClass } from "../look";
import { registerPanel, type PanelProps } from "../panels";
import { Figure } from "./parts";
import type { MoneyPanel } from "@/lib/erp/screens/money";

/* ---------------------------------------------------------------------------
 * A Petty Cash record: the figures that matter (the amount, what the bank has
 * matched, what is left of a cash receipt), where the money went, the history,
 * and the bills themselves. The server says everything; this only draws it.
 * ------------------------------------------------------------------------- */

const TONE = { danger: "text-danger", success: "text-success", muted: "text-muted" } as const;

function Money({ data }: PanelProps) {
  const d = data as MoneyPanel;
  return (
    <section className={cx("grid gap-3", insetClass)}>
      {d.figures.length ? (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(d.figures.length, 4)}, minmax(0, 1fr))` }}>
          {d.figures.map((f) => (
            <Figure key={f.l} l={f.l} v={f.v} tone={f.tone} />
          ))}
        </div>
      ) : null}
      {d.note ? (
        <Callout tone="warn" className="mb-0 block text-meta">
          {d.note}
        </Callout>
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
      {d.files.length ? (
        <div className="grid gap-1.5">
          <SectionLabel>Bills and slips</SectionLabel>
          <div className="grid grid-cols-3 gap-2">
            {d.files.map((f) => (
              <a key={f.id} href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-control border border-divider" title={f.name}>
                {f.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/attachments/${f.id}`} alt={f.name} className="block h-24 w-full bg-canvas object-cover" />
                ) : (
                  <span className="flex h-24 items-center justify-center bg-canvas px-2 text-center text-xs text-body">{f.name}</span>
                )}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

registerPanel("money", Money);
