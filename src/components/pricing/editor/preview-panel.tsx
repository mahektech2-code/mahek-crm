"use client";

/* ---------------------------------------------------------------------------
 * THE PAPER ITSELF, and the proof it says what was typed.
 *
 * The left of this step is the actual PDF, drawn in the browser by the same
 * function the server uses — not an HTML imitation of it — so what is seen
 * here is byte for byte what Download saves and what a shop is sent.
 *
 * The right is "Read it back": the PDF goes through the importer — the text
 * extractor, the grid reader, the catalogue matcher — exactly as a list
 * emailed in from outside would, and each stage is shown as it actually ran
 * with what it found. The import pipeline, run in reverse over our own paper.
 * If a figure came back different, the cell is named.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Badge, Button, Callout, cx } from "@/components/ui/primitives";
import { downloadCsv, toCsv } from "@/lib/csv";
import { CSV_HEADERS, sheetCsvRows, type PriceSheet, type ReadBack, type SheetProduct } from "@/lib/price-sheet";

type Verify = {
  readBack: ReadBack;
  stages: Array<{ key: string; label: string; detail: string; ms: number }>;
  pageCount: number;
  byteSize: number;
  extractedText: string;
  confidence: number;
  warnings: string[];
};

export function PreviewPanel({ sheet, products }: { sheet: PriceSheet; products: SheetProduct[] }) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [drawing, setDrawing] = React.useState(true);
  const [drawError, setDrawError] = React.useState<string | null>(null);
  const bytesRef = React.useRef<Uint8Array | null>(null);
  const frameRef = React.useRef<HTMLIFrameElement>(null);

  const [verify, setVerify] = React.useState<Verify | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  const [verifyError, setVerifyError] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState(0);
  const [onlyDiffs, setOnlyDiffs] = React.useState(true);

  /* Draw on mount and whenever the sheet changes, a beat after the last change. */
  React.useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    const timer = setTimeout(async () => {
      try {
        const { renderPriceSheetPdf } = await import("@/lib/price-sheet-pdf");
        const bytes = await renderPriceSheetPdf(sheet);
        if (cancelled) return;
        bytesRef.current = bytes;
        made = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/pdf" }));
        setUrl(made);
        setDrawError(null);
      } catch (e) {
        if (!cancelled) setDrawError(e instanceof Error ? e.message : "The PDF could not be drawn.");
      } finally {
        if (!cancelled) setDrawing(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (made) URL.revokeObjectURL(made);
    };
  }, [sheet]);

  function filename(ext: string) {
    return `${(sheet.name || "price-list").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.${ext}`;
  }

  function download() {
    if (!bytesRef.current) return;
    const href = URL.createObjectURL(new Blob([bytesRef.current.slice()], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = href;
    a.download = filename("pdf");
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function csv() {
    const map = new Map(products.map((p) => [p.id, p]));
    downloadCsv((sheet.name || "price-list").replace(/[^A-Za-z0-9]+/g, "-"), toCsv([...CSV_HEADERS], sheetCsvRows(sheet, map)));
  }

  async function readBack() {
    setVerifying(true);
    setVerifyError(null);
    setVerify(null);
    setRevealed(0);
    try {
      const r = await fetch("/api/price-lists/sheet/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sheet),
      });
      const body = (await r.json()) as Verify & { error?: string };
      if (!r.ok) throw new Error(body.error ?? "The paper could not be read back.");
      setVerify(body);
      // Each stage is revealed in turn — they ran in turn, and a list of five
      // results appearing at once reads as one result.
      body.stages.forEach((_, i) => setTimeout(() => setRevealed((n) => Math.max(n, i + 1)), 320 * (i + 1)));
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : "The paper could not be read back.");
    } finally {
      setVerifying(false);
    }
  }

  const done = verify && revealed >= verify.stages.length;
  const cells = verify ? verify.readBack.cells.filter((c) => !onlyDiffs || !c.samePrice || !c.sameProduct) : [];

  return (
    <div className="grid h-full min-h-0 gap-0 lg:grid-cols-[1fr_400px]">
      <div className="flex min-h-[420px] flex-col border-r border-divider bg-[#525659]">
        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-black/20 bg-[#3c3f41] px-3 py-2">
          <span className="text-[12px] text-white/80">{drawing ? "Drawing the PDF…" : drawError ? "Could not draw" : "The PDF, exactly as it will be sent"}</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="dark" onClick={download} disabled={!url}>
              Download PDF
            </Button>
            <Button size="sm" variant="dark" onClick={() => frameRef.current?.contentWindow?.print()} disabled={!url}>
              Print
            </Button>
            <Button size="sm" variant="dark" onClick={() => url && window.open(url, "_blank", "noopener")} disabled={!url}>
              Open in a tab
            </Button>
            <Button size="sm" variant="dark" onClick={csv}>
              CSV
            </Button>
          </div>
        </div>
        {drawError ? (
          <div className="p-6">
            <Callout tone="danger">{drawError}</Callout>
          </div>
        ) : url ? (
          <iframe ref={frameRef} src={`${url}#view=FitH`} title="Price list preview" className="min-h-0 w-full flex-1 border-0" />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-white/70">Drawing…</div>
        )}
      </div>

      <div className="min-h-0 overflow-auto px-5 py-4">
        <h3 className="text-sm font-semibold text-ink">Read it back</h3>
        <p className="mt-1 text-[13px] text-muted">
          Puts this PDF through the importer — the same reader every list emailed in goes through — and checks the paper
          says exactly what was typed.
        </p>
        <Button className="mt-3 w-full" variant="primary" onClick={() => void readBack()} disabled={verifying}>
          {verifying ? "Reading…" : verify ? "Read it back again" : "Read it back"}
        </Button>
        {verifyError ? <Callout tone="danger" className="mt-3">{verifyError}</Callout> : null}

        {verifying || verify ? (
          <ol className="mt-4 space-y-2">
            {(verify?.stages ?? [{ key: "wait", label: "Sending the sheet", detail: "", ms: 0 }]).map((s, i) => {
              const shown = verify ? i < revealed : false;
              const active = verify ? i === revealed : true;
              return (
                <li key={s.key} className={cx("flex gap-3 rounded-[6px] border px-3 py-2", shown ? "border-line bg-surface" : "border-dashed border-line bg-canvas")}>
                  <span
                    className={cx(
                      "mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-bold",
                      shown ? "bg-success text-white" : active ? "animate-pulse bg-brand-soft text-brand" : "bg-divider text-muted",
                    )}
                  >
                    {shown ? "✓" : i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{s.label}</span>
                    {shown ? (
                      <span className="block text-[12px] text-muted">
                        {s.detail} <span className="text-line-strong">· {s.ms} ms</span>
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}

        {verify && done ? (
          <div className="mt-4 space-y-3">
            {verify.readBack.ok ? (
              <div className="rounded-[6px] border border-success bg-success-soft px-3 py-2.5 text-[13px] text-ink">
                <span className="font-semibold">The paper matches.</span> Every one of {verify.readBack.cells.length} cells and the header read back exactly as typed.
              </div>
            ) : (
              <div className="rounded-[6px] border border-danger bg-danger-soft px-3 py-2.5 text-[13px] text-ink">
                <span className="font-semibold">The paper does not match.</span>{" "}
                {verify.readBack.priceMismatches + verify.readBack.missing} cell(s) and {verify.readBack.headerMismatches.length} header fact(s) read back differently.
              </div>
            )}
            {verify.readBack.headerMismatches.map((m) => (
              <p key={m} className="text-[13px] text-danger">
                {m}
              </p>
            ))}
            {verify.readBack.productMismatches ? (
              <p className="text-[12px] text-muted">
                {verify.readBack.productMismatches} cell(s) would be matched to a different SKU if this PDF were imported somewhere
                else. That does not change this list — it stores the SKU it was built with — but a clearer printed name
                helps the next reader.
              </p>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">Cell by cell</span>
              <label className="flex items-center gap-1.5 text-[12px] text-muted">
                <input type="checkbox" className="accent-[#6835FB]" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} />
                Only differences
              </label>
            </div>
            {cells.length ? (
              <div className="max-h-[300px] overflow-auto rounded-[6px] border border-line">
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-canvas text-muted">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">Cell</th>
                      <th className="px-2 py-1 text-right font-medium">Typed</th>
                      <th className="px-2 py-1 text-right font-medium">Read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cells.map((c, i) => (
                      <tr key={i} className="border-t border-divider">
                        <td className="px-2 py-1 text-body">
                          {c.rowLabel} · {c.sizeLabel}
                          {!c.sameProduct ? <Badge tone="muted" className="ml-1">other SKU</Badge> : null}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{c.typed}</td>
                        <td className={cx("px-2 py-1 text-right tabular-nums", c.samePrice ? "text-success" : "font-medium text-danger")}>{c.read ?? "missing"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[12px] text-muted">Nothing differs.</p>
            )}
            <details className="rounded-[6px] border border-line">
              <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-body">What the reader saw ({verify.pageCount} page{verify.pageCount === 1 ? "" : "s"})</summary>
              <pre className="max-h-[260px] overflow-auto border-t border-divider bg-canvas px-3 py-2 text-[11px] leading-[16px] whitespace-pre-wrap text-body">{verify.extractedText}</pre>
            </details>
          </div>
        ) : null}
      </div>
    </div>
  );
}
