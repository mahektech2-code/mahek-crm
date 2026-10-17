"use client";

import { cx, SectionLabel } from "@/components/ui/primitives";
import { registerPanel, type PanelProps } from "../panels";
import { Stepper } from "./parts";

/* ---------------------------------------------------------------------------
 * The purchase flow, drawn in the drawer of a requirement and of a PO:
 *
 *   Requirement → Blind count → Vendor → Approval → PO → Receipt
 *
 * A stepper saying which step is waiting and what happens next, then what
 * this record holds of the flow — or the PO's lines with what has arrived
 * against each.
 * Everything here is the server's answer; the panel only draws it.
 * ------------------------------------------------------------------------- */

type Fact = { l: string; v: string; href?: string };
type Flow = {
  steps: string[];
  step: number;
  stage: string;
  next: string;
  facts: Fact[];
};

function PurchaseFlow({ data }: PanelProps) {
  const f = data as Flow;
  return (
    <section className="grid gap-3 rounded-card border border-line p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Purchase flow</SectionLabel>
        <span className="text-xs text-muted">{f.stage}</span>
      </div>
      <Stepper steps={f.steps} step={f.step} label="Purchase flow" />
      {/* Once every step is done there is no next one; the stage above says so. */}
      {f.step < f.steps.length ? (
        <div className={cx("rounded-control px-3 py-2 text-meta", f.step < 0 ? "bg-canvas text-muted" : "bg-brand-soft text-brand-hover")}>
          <span className="font-semibold">Next · </span>
          {f.next}
        </div>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
        {f.facts.map((x) => (
          <div key={x.l} className="min-w-0">
            <dt className="text-xs font-medium tracking-[0.04em] text-muted uppercase">{x.l}</dt>
            <dd className="mt-0.5 text-sm break-words text-ink">
              {x.href ? (
                <a href={x.href} className="text-brand-hover underline-offset-2 hover:underline">
                  {x.v}
                </a>
              ) : (
                x.v
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

type PoData = {
  steps: string[];
  step: number;
  status: string;
  money: boolean;
  lines: { item: string; ordered: string; received: string; pending: string; done: boolean; rate: string | null; gst: string; total: string | null; requirement: string }[];
  totals: { amount: string; gst: string; freight: string; total: string } | null;
  history: { l: string; v: string }[];
  print: string | null;
};

function PurchaseOrder({ data }: PanelProps) {
  const p = data as PoData;
  return (
    <section className="grid gap-3 rounded-card border border-line p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Purchase flow</SectionLabel>
        {p.print ? (
          <a href={p.print} className="text-xs text-brand-hover hover:underline">
            Open the printable PO
          </a>
        ) : null}
      </div>
      <Stepper steps={p.steps} step={p.step} label="Purchase flow" />
      {/* A row per line rather than a seven-column table: the item and what it
          costs on top, the quantities beneath — readable at a drawer's width. */}
      <div className="overflow-hidden rounded-control border border-divider text-meta">
        {p.lines.map((l, i) => (
          <div key={i} className={cx("px-3 py-2", i > 0 && "border-t border-divider")}>
            <div className="flex items-baseline justify-between gap-3">
              <a href={l.requirement} className="min-w-0 font-medium break-words text-ink hover:text-brand-hover hover:underline" title="Open its requirement">
                {l.item}
              </a>
              {p.money ? <span className="flex-none font-semibold text-ink tabular-nums">{l.total}</span> : null}
            </div>
            <dl className="mt-1 grid grid-cols-5 gap-x-3 text-xs">
              {[
                ["Ordered", l.ordered, ""],
                ["Received", l.received, l.done ? "text-success" : ""],
                ["Pending", l.done ? "—" : l.pending, ""],
                ...(p.money ? [["Rate", l.rate ?? "—", ""]] : []),
                ["GST", l.gst, ""],
              ].map(([k, v, tone]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-2xs text-muted">{k}</dt>
                  <dd className={cx("truncate text-body tabular-nums", tone)} title={v}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        {p.totals ? (
          <div className="border-t border-line bg-canvas px-3 py-2 text-right text-body">
            Amount {p.totals.amount} · GST {p.totals.gst}
            {p.totals.freight !== "₹0" ? ` · freight ${p.totals.freight}` : ""} · <span className="font-semibold text-ink">Total {p.totals.total}</span>
          </div>
        ) : null}
      </div>
      <dl className="grid gap-1.5">
        {p.history.map((h) => (
          <div key={h.l} className="flex gap-2 text-meta">
            <dt className="w-28 flex-none text-muted">{h.l}</dt>
            <dd className="min-w-0 text-ink">{h.v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

registerPanel("purchaseFlow", (p) => <PurchaseFlow {...p} />);
registerPanel("purchaseOrder", (p) => <PurchaseOrder {...p} />);
