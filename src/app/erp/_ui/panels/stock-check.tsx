"use client";

import { Callout, cx, SectionLabel } from "@/components/ui/primitives";
import { qty } from "@/lib/erp/ui";
import { insetClass, linkClass } from "../look";
import { registerPanel, type PanelProps } from "../panels";
import { Figure, Stepper } from "./parts";
import type { StockCountPanel } from "@/lib/erp/screens/stock-check";

/* ---------------------------------------------------------------------------
 * One stock count, in its record: where the check has got to
 * (Count → Compare → Recount → Investigate → Resolve),
 * the count against the book, every count of it in order, and the causes the
 * records suggest. While the count is OPEN nothing here shows the book — the
 * counter may be the one reading it.
 * ------------------------------------------------------------------------- */

const fmt = (n: number | null | undefined) => (n == null ? "—" : qty(n));
const signed = (n: number | null | undefined) => (n == null ? "—" : `${n > 0 ? "+" : ""}${fmt(n)}`);

function StockCount({ data }: PanelProps) {
  const d = data as StockCountPanel;
  const within = d.difference != null && d.tolerance != null && Math.abs(d.difference) <= d.tolerance;
  return (
    <section className={cx("grid gap-3", insetClass)}>
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Inventory accuracy</SectionLabel>
        <span className="text-xs text-muted">
          {d.number} · {d.kind}
        </span>
      </div>
      <Stepper steps={d.steps} step={d.step} label="Inventory accuracy control" />
      <div className="text-meta text-body">
        {d.item} at {d.godown} · {d.reason}
        {d.requirement ? (
          <>
            {" · "}
            <a href={d.requirement.href} className={linkClass("brand")}>
              {d.requirement.label}
            </a>
          </>
        ) : null}
      </div>

      {d.blind ? (
        <Callout tone="info" className="mb-0 block text-meta text-info">
          <span className="font-semibold">Blind count · </span>
          Count what is on the shelf, in {d.unit === "Pcs" ? "pieces" : "litres"}. The book quantity stays hidden until the count is submitted, so the figure is what is there and not what is expected.
        </Callout>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Figure l={`Counted (${d.unit})`} v={fmt(d.counted)} />
            <Figure l="Book" v={fmt(d.reconciled)} />
            <Figure l="Difference" v={signed(d.difference)} tone={d.difference == null ? undefined : within ? "success" : "danger"} />
          </div>
          <p className="text-meta text-muted">
            The book is the ledger stock{d.pendingIn ? ` (${fmt(d.book)}) plus ${fmt(d.pendingIn)} received and not yet posted` : ""}, read when the count was submitted. Tolerance ±{fmt(d.tolerance)}.
          </p>
        </>
      )}

      {d.history.length ? (
        <div className="grid gap-1">
          <SectionLabel>Counts</SectionLabel>
          <ul className="grid gap-1 text-meta">
            {d.history.map((h) => (
              <li key={h.label} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-divider pb-1 last:border-0">
                <span className="font-medium text-ink">{h.label}</span>
                <span className="tabular-nums text-body">{h.qty == null ? "Not counted yet" : `${fmt(h.qty)} ${d.unit}`}</span>
                <span className="w-full text-xs text-muted">
                  {h.who ? `${h.who} · ` : ""}
                  {h.at ?? ""}
                  {h.note ? ` · ${h.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {d.ai?.summary ? (
        <div className="grid gap-1.5 rounded-control border border-brand-softer bg-brand-soft px-3 py-2">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Assistant · a suggestion</SectionLabel>
            <span className="text-xs text-muted">Nothing has been entered</span>
          </div>
          <p className="text-meta text-ink">{d.ai.summary}</p>
          {d.ai.ranked?.length ? (
            <ol className="grid gap-1 text-meta">
              {d.ai.ranked.map((r) => (
                <li key={r.title}>
                  <span className="font-medium">{r.title}</span>
                  <span className="text-muted"> · {r.likelihood} · {r.missing === "physical" ? "goods missing" : "a record missing"}</span>
                  <div className="text-body">{r.why}</div>
                </li>
              ))}
            </ol>
          ) : null}
          {d.ai.nextStep ? (
            <p className="text-meta">
              <span className="font-semibold">Next · </span>
              {d.ai.nextStep}
            </p>
          ) : null}
        </div>
      ) : null}

      {d.causes.length ? (
        <div className="grid gap-1.5">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Possible causes, from the records</SectionLabel>
            <span className="text-xs text-muted">Suggestions — check each one</span>
          </div>
          <ul className="grid gap-2">
            {d.causes.map((c, i) => (
              <li key={`${c.title}-${i}`} className={cx("rounded-control border px-3 py-2 text-meta", c.likelihood === "likely" ? "border-warn-line bg-warn-soft" : "border-divider")}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="font-semibold text-ink">{c.title}</span>
                  <span className="text-xs text-muted">
                    {c.likelihood === "likely" ? "Likely" : "Possible"} · {c.missing === "physical" ? "goods missing" : "a record missing"}
                    {c.qty != null ? ` · ${signed(c.qty)}` : ""}
                  </span>
                </div>
                <div className="mt-0.5 text-body">{c.detail}</div>
                {c.href ? (
                  <a href={c.href} className={linkClass("brand", "mt-1 inline-block text-xs")}>
                    Open the record
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {d.adjustment ? (
        <div className="rounded-control border border-divider px-3 py-2 text-meta">
          <SectionLabel>Adjustment</SectionLabel>
          <div className="mt-1">
            <span className="font-semibold tabular-nums">
              {signed(d.adjustment.qty)} {d.unit}
            </span>{" "}
            · {d.adjustment.reason}
          </div>
          <div className="text-xs text-muted">
            {d.adjustment.status === "pending" ? `Requested by ${d.adjustment.by ?? "—"} · waiting for somebody else to approve it` : `${d.adjustment.status === "approved" ? "Approved" : "Rejected"} by ${d.adjustment.decidedBy ?? "—"}`}
            {d.adjustment.note ? ` · ${d.adjustment.note}` : ""}
          </div>
        </div>
      ) : null}

      {d.resolution ? (
        <Callout tone="success" className="mb-0 block text-meta text-success">
          <span className="font-semibold">{d.resolution.label}</span>
          {d.resolution.by ? ` · ${d.resolution.by}` : ""}
          {d.resolution.note ? <div className="text-body">{d.resolution.note}</div> : null}
        </Callout>
      ) : null}
    </section>
  );
}

registerPanel("stockCount", StockCount);
