"use client";

import { useEffect, useState } from "react";
import { Callout, cx, SectionLabel } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { inr, nf } from "@/lib/erp/ui";
import { erpInvoicePanel } from "@/lib/actions/erp-tracking";
import type { InvoicePanel } from "@/lib/erp/invoice-panel";
import { erpInvoicesPdfHref } from "@/lib/erp/trace-links";
import { PdfViewer } from "../pdf-viewer";
import type { PdfDoc } from "../pdf-render";
import { Copies, PrintButton, usePrinter } from "../invoice-modals";
import { registerPanel, type PanelProps } from "../panels";
import { resultError } from "../use-act";
import { useErpUi } from "../erp-ui";
import { Icon } from "../icons";
import { insetClass } from "../look";

/* ---------------------------------------------------------------------------
 * The order record's Invoice tab: the uploaded Tally PDF in our own viewer,
 * beside the order's lines so a checker reads one against the other, with
 * copies, Print and Replace. Nothing downloads and nothing opens a tab.
 * ------------------------------------------------------------------------- */

type Line = { sku: string; qty: number; rate: number | null; discount: number | null };
type Data = { orderNo: number; transporter?: string | null; lines?: Line[] };

const base = "inline-flex h-9 items-center gap-1.5 rounded-control border px-3 text-meta font-medium no-underline cursor-pointer";
/* Each look is its own class string: `cx` only joins, so two backgrounds in one string let the stylesheet's order decide. */
const tool = `${base} border-line bg-surface text-body hover:bg-canvas`;

function Body({ data, row, screen }: PanelProps & { data: Data }) {
  const ui = useErpUi();
  const [view, setView] = useState<InvoicePanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [copies, setCopies] = useState(1);
  const { print, busy, error: printError } = usePrinter();
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
        <span className="ml-auto flex flex-wrap items-center gap-2.5">
          {f ? (
            <>
              <Copies value={copies} onChange={setCopies} />
              <PrintButton busy={busy} disabled={!doc} onClick={() => doc && void print([doc], copies)} />
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
          /* Our own viewer: a photographed invoice arrives as a page of the same PDF. */
          <PdfViewer key={f.id} url={erpInvoicesPdfHref([view.orderNo])} onDoc={setDoc} className="h-[70vh]" />
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

      {printError ? <Callout tone="danger">{printError}</Callout> : null}
      {view.uploads.length ? (
        <div className="grid gap-1">
          <SectionLabel>Uploads</SectionLabel>
          {view.uploads.map((u) => (
            <div key={u.id} className="flex items-center gap-2 text-meta text-body">
              <Icon n="file" s={13} />
              <span className={cx("truncate", u.current && "font-semibold text-ink")}>{u.filename}</span>
              <span className="text-muted">
                {stamp(u.at)}
                {u.by ? ` · ${u.by}` : ""}
              </span>
            </div>
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
