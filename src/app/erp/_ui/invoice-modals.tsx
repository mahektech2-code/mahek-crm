"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Callout, checkboxClass, cx } from "@/components/ui/primitives";
import { erpInvoicePanel, erpInvoicePrintList } from "@/lib/actions/erp-tracking";
import type { InvoicePrintItem } from "@/lib/erp/invoice-panel";
import { erpInvoicesPdfHref, INVOICE_COPIES_MAX } from "@/lib/erp/trace-links";
import { DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "./dialog";
import { Icon } from "./icons";
import { PdfViewer } from "./pdf-viewer";
import { openPdf, pageImages, printImages, type PdfDoc } from "./pdf-render";
import { resultError } from "./use-act";

/* ---------------------------------------------------------------------------
 * The invoice opens and prints in a pop-up on the page somebody is working on:
 * one order's invoice from its view or print button, or every invoice of a
 * selection from Print invoices. Our own viewer draws the pages; Print is the
 * only way out of it. One copy each unless somebody changes it.
 * ------------------------------------------------------------------------- */

export function Copies({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const step = "h-10 w-10 cursor-pointer text-lg text-body disabled:cursor-not-allowed disabled:text-line-strong";
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="text-meta text-muted">Copies</span>
      <span className="inline-flex items-center rounded-control border border-line bg-surface">
        <button type="button" aria-label="Fewer copies" disabled={value <= 1} onClick={() => onChange(Math.max(1, value - 1))} className={step}>
          −
        </button>
        <span className="w-7 text-center text-sm font-semibold text-ink tabular-nums" aria-live="polite">
          {value}
        </span>
        <button type="button" aria-label="More copies" disabled={value >= INVOICE_COPIES_MAX} onClick={() => onChange(Math.min(INVOICE_COPIES_MAX, value + 1))} className={step}>
          +
        </button>
      </span>
    </span>
  );
}

/** Prints the documents as pictures of their pages; says so while it gets them ready. */
export function usePrinter() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const print = async (docs: PdfDoc[], copies: number) => {
    if (!docs.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      printImages(await pageImages(docs), copies);
    } catch {
      setError("The invoice could not be prepared for printing. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return { print, busy, error };
}

export function PrintButton({ onClick, busy, disabled, label = "Print" }: { onClick: () => void; busy: boolean; disabled?: boolean; label?: string }) {
  return (
    <Button onClick={onClick} disabled={disabled || busy}>
      <span className="inline-flex items-center gap-2">
        <Icon n="print" s={16} />
        {busy ? "Getting pages ready…" : label}
      </span>
    </Button>
  );
}

/** One order's invoice. `autoPrint` opens the print dialog as soon as the pages are read. */
export function InvoiceModal({ orderNo, party, transporter, autoPrint, onClose }: { orderNo: number; party?: string | null; transporter?: string | null; autoPrint?: boolean; onClose: () => void }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [copies, setCopies] = useState(1);
  const [head, setHead] = useState<{ invoiceNo: string | null; check: string | null } | null>(null);
  const printed = useRef(false);
  const { print, busy, error } = usePrinter();

  useEffect(() => {
    let live = true;
    void erpInvoicePanel(orderNo).then((r) => {
      if (live && r.ok) setHead({ invoiceNo: r.data.invoiceNo, check: r.data.check?.state ?? null });
    });
    return () => {
      live = false;
    };
  }, [orderNo]);

  /* Opened from a print button: print once, as soon as the pages are read. */
  const loaded = (d: PdfDoc | null) => {
    setDoc(d);
    if (autoPrint && d && !printed.current) {
      printed.current = true;
      void print([d], 1);
    }
  };

  const check = head?.check;
  return (
    <ErpDialog onClose={onClose} label={`Invoice · order ${orderNo}`} width={1120}>
      <DialogHeader onClose={onClose}>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-control bg-danger-soft text-2xs font-extrabold text-danger">PDF</span>
          <div className="min-w-0">
            <DialogTitle className="font-mono">{head?.invoiceNo ?? "Invoice"}</DialogTitle>
            <div className="text-meta text-muted">
              Order {orderNo}
              {party ? ` · ${party}` : ""}
            </div>
          </div>
          {transporter ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-meta text-body">
              <Icon n="truck" s={14} />
              {transporter}
            </span>
          ) : null}
          {check ? (
            <span
              className={cx(
                "rounded-full px-3 py-1 text-meta font-semibold",
                check === "Approved" ? "bg-success-soft text-success" : check === "Rejected" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn-ink",
              )}
            >
              {check === "Pending" ? "To check" : check}
            </span>
          ) : null}
        </div>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col p-4">
        <PdfViewer url={erpInvoicesPdfHref([orderNo])} onDoc={loaded} className="min-h-0 flex-1" />
      </div>
      {error ? (
        <div className="px-6 pb-2">
          <Callout tone="danger">{error}</Callout>
        </div>
      ) : null}
      <DialogFooter left={doc ? `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}` : ""}>
        <Copies value={copies} onChange={setCopies} />
        <PrintButton busy={busy} disabled={!doc} onClick={() => doc && void print([doc], copies)} />
      </DialogFooter>
    </ErpDialog>
  );
}

/** Every invoice of a selection: tick what to print, preview any of them, print in one go. */
export function PrintInvoicesModal({ lineIds, onClose }: { lineIds: string[]; onClose: () => void }) {
  const [items, setItems] = useState<InvoicePrintItem[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const [showing, setShowing] = useState<number | null>(null);
  const [pages, setPages] = useState<Record<number, number>>({});
  const [copies, setCopies] = useState(1);
  const [gathering, setGathering] = useState(false);
  const { print, busy, error } = usePrinter();

  useEffect(() => {
    let live = true;
    void erpInvoicePrintList(lineIds).then((r) => {
      if (!live) return;
      if (!r.ok) return setFailed(resultError(r));
      setItems(r.data);
      setTicked(Object.fromEntries(r.data.filter((i) => i.hasPdf).map((i) => [i.orderNo, true])));
      setShowing(r.data.find((i) => i.hasPdf)?.orderNo ?? null);
    });
    return () => {
      live = false;
    };
  }, [lineIds]);

  const chosen = (items ?? []).filter((i) => i.hasPdf && ticked[i.orderNo]);
  /* An invoice shared by several orders is one file: it prints once. */
  const files = [...new Map(chosen.map((i) => [i.fileId, i])).values()];

  const printAll = async () => {
    setGathering(true);
    try {
      const docs = await Promise.all(files.map((i) => openPdf(erpInvoicesPdfHref([i.orderNo]))));
      await print(docs, copies);
    } finally {
      setGathering(false);
    }
  };

  const n = files.length;
  return (
    <ErpDialog onClose={onClose} label="Print invoices" width={1180}>
      <DialogHeader onClose={onClose}>
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-control bg-brand-soft text-brand">
            <Icon n="print" s={18} />
          </span>
          <DialogTitle>Print invoices</DialogTitle>
          {items ? (
            <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-meta font-semibold text-brand">
              {chosen.length} of {items.length} selected
            </span>
          ) : null}
        </div>
      </DialogHeader>
      {failed ? (
        <div className="p-6">
          <Callout tone="danger">{failed}</Callout>
        </div>
      ) : !items ? (
        <div className="grid flex-1 place-items-center text-meta text-muted">Reading the selection…</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[340px] flex-none flex-col gap-2 overflow-y-auto border-r border-line bg-canvas/50 p-3">
            {items.map((i) => (
              <div
                key={i.orderNo}
                role="button"
                tabIndex={i.hasPdf ? 0 : -1}
                onClick={() => i.hasPdf && setShowing(i.orderNo)}
                onKeyDown={(e) => e.key === "Enter" && i.hasPdf && setShowing(i.orderNo)}
                className={cx(
                  "flex items-center gap-3 rounded-card border px-3 py-2.5",
                  !i.hasPdf ? "border-line opacity-60" : showing === i.orderNo ? "cursor-pointer border-brand bg-brand-soft" : "cursor-pointer border-line bg-surface hover:bg-canvas",
                )}
              >
                <input
                  type="checkbox"
                  aria-label={`Print order ${i.orderNo}`}
                  className={checkboxClass}
                  disabled={!i.hasPdf}
                  checked={!!ticked[i.orderNo]}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => setTicked((t) => ({ ...t, [i.orderNo]: !t[i.orderNo] }))}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-meta font-semibold text-ink">
                    {i.orderNo}
                    {i.invoiceNo ? <span className="font-mono font-medium"> · {i.invoiceNo}</span> : null}
                  </div>
                  <div className="truncate text-xs text-muted">{i.party}</div>
                </div>
                {i.hasPdf ? (
                  pages[i.orderNo] ? <span className="text-xs text-muted">{pages[i.orderNo]} p</span> : null
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-danger">
                    <Icon n="warn" s={13} />
                    No PDF
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col p-4">
            {showing != null ? (
              <PdfViewer
                key={showing}
                url={erpInvoicesPdfHref([showing])}
                onDoc={(d) => d && setPages((p) => ({ ...p, [showing]: d.numPages }))}
                className="min-h-0 flex-1"
              />
            ) : (
              <div className="grid flex-1 place-items-center text-meta text-muted">None of these orders has an invoice PDF.</div>
            )}
          </div>
        </div>
      )}
      {error ? (
        <div className="px-6 pb-2">
          <Callout tone="danger">{error}</Callout>
        </div>
      ) : null}
      <DialogFooter left={n ? `${copies} cop${copies === 1 ? "y" : "ies"} of each` : ""}>
        <Copies value={copies} onChange={setCopies} />
        <PrintButton busy={busy || gathering} disabled={!n} onClick={() => void printAll()} label={n === 1 ? "Print 1 invoice" : `Print ${n} invoices`} />
      </DialogFooter>
    </ErpDialog>
  );
}
