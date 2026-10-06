"use client";

import { cx, SectionLabel } from "@/components/ui/primitives";
import { registerPanel, type PanelProps } from "../panels";

/* ---------------------------------------------------------------------------
 * The purchase flow, drawn in the drawer of a requirement and of a PO:
 *
 *   Requirement → Purchase method → Vendor / quotation → Approval → PO → Receipt
 *
 * A stepper saying which step is waiting and what happens next, then what
 * this record holds of the flow — the quotations side by side with the lowest
 * landed cost marked, or the PO's lines with what has arrived against each.
 * Everything here is the server's answer; the panel only draws it.
 * ------------------------------------------------------------------------- */

function Stepper({ steps, step, label }: { steps: readonly string[]; step: number; label: string }) {
  const cancelled = step < 0;
  return (
    <ol className="grid grid-cols-6 gap-1" aria-label={label}>
      {steps.map((s, i) => {
        const done = !cancelled && i < step;
        const now = !cancelled && i === step;
        return (
          <li key={s} className="grid min-w-0 gap-1">
            <span className={cx("h-1.5 rounded-full", done ? "bg-success" : now ? "bg-brand" : "bg-divider")} />
            <span className={cx("text-[11px] leading-[14px] break-words", now ? "font-semibold text-ink" : done ? "text-body" : "text-muted")} title={s}>
              {done ? "✓ " : ""}
              {s}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

type Fact = { l: string; v: string; href?: string };
type QuoteRow = {
  vendor: string;
  rate: string | null;
  gst: string;
  freight: string | null;
  landed: string | null;
  delivery: string;
  terms: string;
  validUntil: string;
  lowest: boolean;
  expired: boolean;
  selected: boolean;
  document: string | null;
};
type Flow = {
  steps: string[];
  step: number;
  stage: string;
  next: string;
  facts: Fact[];
  quotes: { min: number; money: boolean; rows: QuoteRow[] } | null;
};

function PurchaseFlow({ data }: PanelProps) {
  const f = data as Flow;
  return (
    <section className="grid gap-3 rounded-[6px] border border-line p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Purchase flow</SectionLabel>
        <span className="text-xs text-muted">{f.stage}</span>
      </div>
      <Stepper steps={f.steps} step={f.step} label="Purchase flow" />
      <div className={cx("rounded-[4px] px-3 py-2 text-[13px]", f.step < 0 ? "bg-canvas text-muted" : "bg-brand-soft text-[#5223E0]")}>
        <span className="font-semibold">Next · </span>
        {f.next}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
        {f.facts.map((x) => (
          <div key={x.l} className="min-w-0">
            <dt className="text-xs font-medium tracking-[0.04em] text-muted uppercase">{x.l}</dt>
            <dd className="mt-0.5 text-sm break-words text-ink">
              {x.href ? (
                <a href={x.href} className="text-[#5223E0] underline-offset-2 hover:underline">
                  {x.v}
                </a>
              ) : (
                x.v
              )}
            </dd>
          </div>
        ))}
      </dl>
      {f.quotes ? (
        <div className="grid gap-1.5">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Quotations compared</SectionLabel>
            <span className="text-xs text-muted">
              {f.quotes.rows.length} in · at least {f.quotes.min} needed
            </span>
          </div>
          {f.quotes.rows.length ? (
            <div className="overflow-x-auto rounded-[4px] border border-divider">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead className="bg-canvas text-left text-xs text-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Vendor</th>
                    {f.quotes.money ? <th className="px-2 py-1.5 text-right font-medium">Rate</th> : null}
                    <th className="px-2 py-1.5 text-right font-medium">GST</th>
                    {f.quotes.money ? <th className="px-2 py-1.5 text-right font-medium">Freight</th> : null}
                    {f.quotes.money ? <th className="px-2 py-1.5 text-right font-medium">Landed</th> : null}
                    <th className="px-2 py-1.5 font-medium">Delivery</th>
                    <th className="px-2 py-1.5 font-medium">Terms</th>
                    <th className="px-2 py-1.5 font-medium">Valid</th>
                  </tr>
                </thead>
                <tbody>
                  {f.quotes.rows.map((q) => (
                    <tr key={q.vendor} className={cx("border-t border-divider", q.selected && "bg-success-soft/60", q.expired && "text-muted")}>
                      <td className="px-2 py-1.5">
                        <span className="font-medium text-ink">{q.vendor}</span>
                        {q.selected ? <span className="ml-1.5 rounded-[3px] bg-success-soft px-1 text-[11px] text-success">Selected</span> : null}
                        {q.lowest ? <span className="ml-1.5 rounded-[3px] bg-brand-soft px-1 text-[11px] text-[#5223E0]">Lowest</span> : null}
                        {q.expired ? <span className="ml-1.5 rounded-[3px] bg-canvas px-1 text-[11px]">Expired</span> : null}
                        {q.document ? (
                          <a href={`/api/attachments/${q.document}`} target="_blank" rel="noreferrer" className="ml-1.5 text-[11px] text-[#5223E0]">
                            file
                          </a>
                        ) : null}
                      </td>
                      {f.quotes!.money ? <td className="px-2 py-1.5 text-right tabular-nums">{q.rate}</td> : null}
                      <td className="px-2 py-1.5 text-right tabular-nums">{q.gst}</td>
                      {f.quotes!.money ? <td className="px-2 py-1.5 text-right tabular-nums">{q.freight}</td> : null}
                      {f.quotes!.money ? <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{q.landed}</td> : null}
                      <td className="px-2 py-1.5">{q.delivery}</td>
                      <td className="px-2 py-1.5">{q.terms}</td>
                      <td className="px-2 py-1.5">{q.validUntil}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <span className="text-[13px] text-muted">No quotations yet. Add each vendor&apos;s quotation as it comes in.</span>
          )}
          {!f.quotes.money ? <span className="text-xs text-muted">Rates and landed costs are not shown on your account.</span> : null}
        </div>
      ) : null}
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
    <section className="grid gap-3 rounded-[6px] border border-line p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Purchase flow</SectionLabel>
        {p.print ? (
          <a href={p.print} className="text-xs text-[#5223E0] hover:underline">
            Open the printable PO
          </a>
        ) : null}
      </div>
      <Stepper steps={p.steps} step={p.step} label="Purchase flow" />
      <div className="overflow-x-auto rounded-[4px] border border-divider">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead className="bg-canvas text-left text-xs text-muted">
            <tr>
              <th className="px-2 py-1.5 font-medium">Item</th>
              <th className="px-2 py-1.5 text-right font-medium">Ordered</th>
              <th className="px-2 py-1.5 text-right font-medium">Received</th>
              <th className="px-2 py-1.5 text-right font-medium">Pending</th>
              {p.money ? <th className="px-2 py-1.5 text-right font-medium">Rate</th> : null}
              <th className="px-2 py-1.5 text-right font-medium">GST</th>
              {p.money ? <th className="px-2 py-1.5 text-right font-medium">Total</th> : null}
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l, i) => (
              <tr key={i} className="border-t border-divider">
                <td className="px-2 py-1.5">
                  <a href={l.requirement} className="font-medium text-ink hover:text-[#5223E0] hover:underline" title="Open its requirement">
                    {l.item}
                  </a>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{l.ordered}</td>
                <td className={cx("px-2 py-1.5 text-right tabular-nums", l.done ? "text-success" : "")}>{l.received}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{l.done ? "—" : l.pending}</td>
                {p.money ? <td className="px-2 py-1.5 text-right tabular-nums">{l.rate}</td> : null}
                <td className="px-2 py-1.5 text-right tabular-nums">{l.gst}</td>
                {p.money ? <td className="px-2 py-1.5 text-right tabular-nums">{l.total}</td> : null}
              </tr>
            ))}
          </tbody>
          {p.totals ? (
            <tfoot className="border-t border-line text-[13px]">
              <tr>
                <td colSpan={7} className="px-2 py-1.5 text-right text-body">
                  Amount {p.totals.amount} · GST {p.totals.gst}
                  {p.totals.freight !== "₹0" ? ` · freight ${p.totals.freight}` : ""} · <span className="font-semibold text-ink">Total {p.totals.total}</span>
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      <dl className="grid gap-1.5">
        {p.history.map((h) => (
          <div key={h.l} className="flex gap-2 text-[13px]">
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
