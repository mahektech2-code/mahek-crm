"use client";

import { useRef, useState } from "react";
import { Callout } from "@/components/ui/primitives";
import { erpInvoicesPdfHref, INVOICE_COPIES_MAX } from "@/lib/erp/trace-links";
import { Icon } from "../_ui/icons";

/* The print sheet: copies (1 unless changed), Print, Download, and the joined PDF itself. */

const base = "inline-flex h-10 items-center gap-2 rounded-control border px-3.5 text-sm no-underline cursor-pointer";
const tool = `${base} border-line bg-surface font-medium text-body hover:bg-canvas`;
const primary = `${base} border-brand bg-brand font-semibold text-white hover:bg-brand-hover`;

export function InvoicePrinter({ orders, missing, copies: start }: { orders: number[]; missing: number[]; copies: number }) {
  const [copies, setCopies] = useState(start);
  const frame = useRef<HTMLIFrameElement>(null);
  const src = erpInvoicesPdfHref(orders, { copies });
  const print = () => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    w.focus();
    w.print();
  };
  return (
    <div className="grid gap-4">
      {missing.length ? (
        <Callout tone="danger">
          No invoice PDF on order{missing.length === 1 ? "" : "s"} {missing.join(", ")} — {missing.length === 1 ? "it is" : "they are"} not in this print.
        </Callout>
      ) : null}
      {orders.length ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-meta text-muted">Copies</span>
            <span className="inline-flex items-center rounded-control border border-line bg-surface">
              <button type="button" aria-label="Fewer copies" disabled={copies <= 1} onClick={() => setCopies((c) => Math.max(1, c - 1))} className="h-10 w-10 cursor-pointer text-lg text-body disabled:cursor-not-allowed disabled:text-line-strong">
                −
              </button>
              <span className="w-8 text-center text-sm font-semibold text-ink tabular-nums" aria-live="polite">
                {copies}
              </span>
              <button type="button" aria-label="More copies" disabled={copies >= INVOICE_COPIES_MAX} onClick={() => setCopies((c) => Math.min(INVOICE_COPIES_MAX, c + 1))} className="h-10 w-10 cursor-pointer text-lg text-body disabled:cursor-not-allowed disabled:text-line-strong">
                +
              </button>
            </span>
            <span className="ml-auto flex flex-wrap gap-2">
              <a className={tool} href={erpInvoicesPdfHref(orders, { copies, download: true })} title="Download as one PDF" aria-label="Download as one PDF">
                <Icon n="dl" s={16} />
              </a>
              <button type="button" onClick={print} className={primary}>
                <Icon n="print" s={16} /> Print {orders.length === 1 ? "invoice" : `${orders.length} invoices`}
              </button>
            </span>
          </div>
          <iframe ref={frame} key={src} title="Invoices" src={`${src}#view=FitH&navpanes=0`} className="h-[78vh] w-full rounded-card border border-line bg-canvas" />
        </>
      ) : (
        <Callout tone="neutral">Nothing to print.</Callout>
      )}
    </div>
  );
}
