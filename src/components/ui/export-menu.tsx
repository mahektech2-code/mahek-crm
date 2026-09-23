"use client";

import * as React from "react";
import { downloadCsv, toCsv } from "@/lib/csv";

/* ---------------------------------------------------------------------------
 * Export — the screen as a PDF, or its rows as a spreadsheet.
 *
 * THE PDF IS THE SCREEN, printed. A target or a month's score is sent to the
 * salesman it belongs to, and the thing he should receive is exactly what his
 * manager was looking at when they pressed the button — the same figures, the
 * same words, the same colours. A second layout drawn for paper would be a
 * second copy of every screen, and the copy that drifts is always the one that
 * leaves the building. So the browser prints the page, and `globals.css` takes
 * the app's chrome off it: the header, the sidebar, and every screen's own
 * action buttons, which mean nothing on paper.
 *
 * WIDE TABLES ARE SCALED, NEVER CUT. A table here scrolls sideways on screen
 * rather than wrapping a name, and paper cannot scroll — a 1,324px table on a
 * landscape A4 simply loses its right-hand columns. The widest table on the
 * page is measured at the click and the page is zoomed just enough to fit it.
 *
 * The filename is the document title, which is what every browser offers as
 * the PDF's name, so it is set for the length of the print and put back.
 * ------------------------------------------------------------------------- */

type CsvRows = Array<Array<string | number | null | undefined>>;

/** Landscape A4 less the 10mm margins `globals.css` sets, in CSS pixels. */
const PRINTABLE_WIDTH_PX = ((297 - 20) * 96) / 25.4;
/** The screens' own `p-6` either side of the content. */
const PAGE_PADDING_PX = 48;

function printScreen(title: string) {
  const root = document.documentElement;
  const main = document.querySelector("main") ?? document.body;
  const widest = Math.max(
    0,
    ...Array.from(main.querySelectorAll("table")).map((t) => t.scrollWidth),
  );
  const zoom = widest ? Math.min(1, PRINTABLE_WIDTH_PX / (widest + PAGE_PADDING_PX)) : 1;

  const previousTitle = document.title;
  root.style.setProperty("--print-zoom", String(Math.floor(zoom * 100) / 100));
  document.title = title;

  const restore = () => {
    document.title = previousTitle;
    root.style.removeProperty("--print-zoom");
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  window.print();
}

export function ExportMenu({
  name,
  csv,
}: {
  /** What the file is — "Sales targets, September 2026". Names both files. */
  name: string;
  /**
   * The rows, header first — as rows from a server component, or as a function
   * from a client one so they are only built on the click. Omitted where a
   * screen has no table to hand over, and then the menu offers the PDF alone.
   */
  csv?: CsvRows | (() => CsvRows);
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items = [
    {
      label: "PDF — this screen, ready to send",
      onSelect: () => {
        setOpen(false);
        // After the menu has closed, or the menu is what gets printed.
        requestAnimationFrame(() => requestAnimationFrame(() => printScreen(name)));
      },
    },
    ...(csv
      ? [
          {
            label: "CSV — the rows, for a spreadsheet",
            onSelect: () => {
              setOpen(false);
              const [headers, ...lines] = typeof csv === "function" ? csv() : csv;
              if (!headers) return;
              downloadCsv(name, toCsv(headers.map((h) => String(h ?? "")), lines), [name]);
            },
          },
        ]
      : []),
  ];

  return (
    <span ref={ref} className="relative inline-flex print:hidden">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-[13px] text-body hover:bg-canvas"
      >
        Export
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open ? (
        <span
          role="menu"
          className="absolute top-full right-0 z-40 mt-1 flex min-w-[260px] flex-col rounded-[6px] border border-line bg-surface py-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={item.onSelect}
              className="cursor-pointer px-3 py-2 text-left text-[13px] whitespace-nowrap text-body hover:bg-canvas"
            >
              {item.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
