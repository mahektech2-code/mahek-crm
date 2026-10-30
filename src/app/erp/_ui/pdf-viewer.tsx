"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui/primitives";
import { drawPage, openPdf, type PdfDoc } from "./pdf-render";
import { IconButton } from "./look";
import { Icon } from "./icons";

/* ---------------------------------------------------------------------------
 * The ERP's PDF viewer: page thumbnails down the left, one page in the middle,
 * and our own toolbar — previous, next, zoom, fit. Every page is drawn on a
 * canvas we own, so there is nothing to download and nothing opens a tab.
 * ------------------------------------------------------------------------- */

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function Page({ doc, n, width, className }: { doc: PdfDoc; n: number; width: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current && width > 0) void drawPage(doc, n, ref.current, width).catch(() => undefined);
  }, [doc, n, width]);
  return <canvas ref={ref} className={cx("block bg-white", className)} aria-label={`Page ${n}`} />;
}

/** Loads the PDF at `url` and draws it. `onDoc` hands the document up, for printing. */
export function PdfViewer({ url, onDoc, className }: { url: string; onDoc?: (doc: PdfDoc | null) => void; className?: string }) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [avail, setAvail] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  /* The latest onDoc, so a parent passing a fresh function each render does not reload the file. */
  const tell = useRef(onDoc);
  useEffect(() => {
    tell.current = onDoc;
  });

  useEffect(() => {
    let live = true;
    openPdf(url)
      .then((d) => {
        if (!live) return;
        setDoc(d);
        tell.current?.(d);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "The invoice could not be opened."));
    return () => {
      live = false;
    };
  }, [url]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  if (error)
    return (
      <div className={cx("grid place-items-center rounded-card bg-danger-soft p-8 text-danger", className)}>
        <span className="grid justify-items-center gap-2 text-sm font-semibold">
          <Icon n="warn" s={24} />
          {error}
        </span>
      </div>
    );
  if (!doc)
    return (
      <div className={cx("grid place-items-center rounded-card bg-canvas text-meta text-muted", className)}>
        Opening the invoice…
      </div>
    );

  const total = doc.numPages;
  const fit = Math.max(240, avail - 48);
  const width = zoom === "fit" ? fit : Math.round(fit * zoom);
  const zi = zoom === "fit" ? ZOOMS.indexOf(1) : ZOOMS.indexOf(zoom);
  const pct = zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`;

  return (
    <div className={cx("flex min-h-0 overflow-hidden rounded-card border border-line bg-canvas", className)}>
      {total > 1 ? (
        <div className="flex w-[116px] flex-none flex-col items-center gap-3 overflow-y-auto border-r border-line py-3">
          {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setPage(n)}
              aria-label={`Page ${n}`}
              aria-current={n === page}
              className={cx("grid cursor-pointer justify-items-center gap-1 rounded-control p-1", n === page ? "ring-2 ring-brand" : "hover:bg-surface")}
            >
              <Page doc={doc} n={n} width={78} className="shadow-sm" />
              <span className={cx("text-xs font-semibold", n === page ? "text-brand" : "text-muted")}>{n}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-none justify-center p-2">
          <div className="inline-flex items-center gap-0.5 rounded-card border border-line bg-surface px-1.5 py-1 shadow-sm">
            <IconButton label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <Icon n="back" s={16} />
            </IconButton>
            <span className="px-1.5 text-meta tabular-nums">
              <b>{page}</b> / {total}
            </span>
            <IconButton label="Next page" disabled={page >= total} onClick={() => setPage((p) => Math.min(total, p + 1))}>
              <Icon n="chev" s={16} />
            </IconButton>
            <span className="mx-1 h-5 w-px bg-line" />
            <IconButton label="Zoom out" disabled={zi <= 0 && zoom !== "fit"} onClick={() => setZoom(ZOOMS[Math.max(0, zi - 1)])}>
              <span className="text-lg leading-none">−</span>
            </IconButton>
            <span className="w-11 text-center text-meta text-body tabular-nums">{pct}</span>
            <IconButton label="Zoom in" disabled={zi >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zi + 1)])}>
              <Icon n="plus" s={16} />
            </IconButton>
            <IconButton label="Fit to width" disabled={zoom === "fit"} onClick={() => setZoom("fit")}>
              <Icon n="zoom" s={16} />
            </IconButton>
          </div>
        </div>
        <div ref={stage} className="min-h-0 flex-1 overflow-auto px-6 pb-6" onContextMenu={(e) => e.preventDefault()}>
          <div className="flex justify-center">
            <Page doc={doc} n={page} width={width} className="shadow-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
