"use client";

import { useEffect, useState } from "react";
import { Callout, cx, SectionLabel } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { inr, nf } from "@/lib/erp/ui";
import { erpInvoicePanel } from "@/lib/actions/erp-tracking";
import type { InvoicePanel } from "@/lib/erp/invoice-panel";
import { erpInvoicePrintHref, erpInvoicesPdfHref } from "@/lib/erp/trace-links";
import { registerPanel, type PanelProps } from "../panels";
import { resultError } from "../use-act";
import { useErpUi } from "../erp-ui";
import { Icon } from "../icons";
import { insetClass } from "../look";

/* ---------------------------------------------------------------------------
 * The order record's Invoice tab: the uploaded Tally PDF itself, beside the
 * order's lines so a checker reads one against the other, with print,
 * download, open and replace as buttons. Read when the tab opens.
 * ------------------------------------------------------------------------- */

type Line = { sku: string; qty: number; rate: number | null; discount: number | null };
type Data = { orderNo: number; transporter?: string | null; lines?: Line[] };

const base = "inline-flex h-9 items-center gap-1.5 rounded-control border px-3 text-meta font-medium no-underline cursor-pointer";
/* Two separate looks, never one class string with overrides on top: `cx` only joins, so
   bg-surface and bg-brand together let the stylesheet's order decide, and white text
   landed on a white button. */
const tool = `${base} border-line bg-surface text-body hover:bg-canvas`;
const primary = `${base} border-brand bg-brand text-white hover:bg-brand-hover`;
/* Chrome's own viewer, opened on the page at full width: no thumbnail strip eating half of it. */
const VIEW = "#view=FitH&navpanes=0";

function Body({ data, row, screen }: PanelProps & { data: Data }) {
  const ui = useErpUi();
  const [view, setView] = useState<InvoicePanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    void erpInvoicePanel(data.orderNo).then((r) => {
      if (!live) return;
      if (r.ok) {
        setView(r.data);
        setError(null);
      } else setError(resultError(r));
    });
    return () => {
      live = false;
    };
  }, [data.orderNo, n]);

  const replace = row.actions?.find((a) => a.id === "invoiceFile");
  const doReplace = () => replace && ui.act(screen, replace, row.id, () => setN((x) => x + 1));

  if (error) return <Callout tone="danger">{error}</Callout>;
  if (!view) return <div className="text-meta text-muted">Opening the invoice…</div>;
  const f = view.file;
  const lines = data.lines ?? [];
  return (
    <div className="grid gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{view.invoiceNo ?? "No invoice number"}</span>
        {view.invoiceDate ? <span className="text-meta text-muted">{view.invoiceDate}</span> : null}
        {view.check ? <CheckPill c={view.check} /> : null}
        <span className="inline-flex items-center gap-1.5 rounded-control bg-canvas px-2 py-0.5 text-meta text-body" title="Transporter">
          <Icon n="truck" s={14} />
          {data.transporter ?? <span className="text-danger">No transporter</span>}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          {f ? (
            <>
              <a className={primary} href={erpInvoicePrintHref([view.orderNo])} target="_blank" rel="noreferrer">
                <Icon n="print" s={15} /> Print
              </a>
              <a className={tool} href={erpInvoicesPdfHref([view.orderNo], { download: true })} title="Download" aria-label="Download">
                <Icon n="dl" s={15} />
              </a>
              <a className={tool} href={erpInvoicesPdfHref([view.orderNo])} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open in a new tab">
                <Icon n="ext" s={15} />
              </a>
            </>
          ) : null}
          {replace ? (
            <button type="button" className={f ? tool : `${base} border-danger/40 bg-danger-soft font-semibold text-danger`} onClick={doReplace}>
              <Icon n="upload" s={15} /> {f ? "Replace" : "Add PDF"}
            </button>
          ) : null}
        </span>
      </div>

      <div className={cx("grid gap-3.5", lines.length > 0 && "lg:grid-cols-[1.6fr_1fr]")}>
        {f ? (
          f.contentType.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/attachments/${f.id}`} alt={`Invoice · order ${view.orderNo}`} className="max-h-[70vh] w-full rounded-card border border-line object-contain" />
          ) : (
            <iframe title={`Invoice · order ${view.orderNo}`} src={`/api/attachments/${f.id}${VIEW}`} className="h-[70vh] w-full rounded-card border border-line bg-canvas" />
          )
        ) : (
          <div className="grid h-64 place-items-center rounded-card border border-dashed border-danger/40 bg-danger-soft text-danger">
            <span className="grid justify-items-center gap-2">
              <Icon n="file" s={28} />
              <span className="text-sm font-semibold">No invoice PDF</span>
            </span>
          </div>
        )}
        {lines.length ? (
          <div className="grid content-start gap-2">
            <SectionLabel>Order {view.orderNo}</SectionLabel>
            {lines.map((l, i) => (
              <div key={i} className={cx("grid gap-0.5", insetClass)}>
                <span className="text-meta font-medium text-ink">{l.sku}</span>
                <span className="text-meta text-muted">
                  {nf(l.qty)} cans{l.rate != null ? ` · ${inr(l.rate)}` : ""}
                  {l.discount ? ` · ${nf(l.discount)}% off` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {view.uploads.length ? (
        <div className="grid gap-1">
          <SectionLabel>Uploads</SectionLabel>
          {view.uploads.map((u) => (
            <a key={u.id} href={`/api/attachments/${u.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-meta text-body no-underline hover:text-brand-hover">
              <Icon n="file" s={13} />
              <span className={cx("truncate", u.current && "font-semibold text-ink")}>{u.filename}</span>
              <span className="text-muted">
                {stamp(u.at)}
                {u.by ? ` · ${u.by}` : ""}
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CheckPill({ c }: { c: NonNullable<InvoicePanel["check"]> }) {
  const tone = c.state === "Approved" ? "bg-success-soft text-success" : c.state === "Rejected" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn-ink";
  const who = c.by ? ` · ${c.by}` : "";
  return (
    <span className={cx("rounded-control px-2 py-0.5 text-meta font-medium", tone)} title={c.note ?? undefined}>
      {c.state === "Pending" ? "To check" : c.state}
      {c.state !== "Pending" ? who : ""}
    </span>
  );
}

function OrderInvoice(p: PanelProps) {
  const d = p.data as Data;
  return <Body key={d.orderNo} {...p} data={d} />;
}

registerPanel("orderInvoice", OrderInvoice);
