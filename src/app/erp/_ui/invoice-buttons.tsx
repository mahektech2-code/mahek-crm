"use client";

import type { ListRow } from "@/lib/erp/ui";
import { erpInvoicePrintHref, erpInvoicesPdfHref } from "@/lib/erp/trace-links";
import { cx } from "@/components/ui/primitives";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";

/* ---------------------------------------------------------------------------
 * An order's invoice, as buttons: view and print where its PDF is attached,
 * a red Add PDF where it is billed without one. Drawn in each order's group
 * heading. Every press stops at the button — the heading is not a row to open.
 * ------------------------------------------------------------------------- */

export function invoiceState(v: unknown): { has: boolean; orderNo: string } | null {
  const m = /^([yn]):(\d+)$/.exec(String(v ?? ""));
  return m ? { has: m[1] === "y", orderNo: m[2] } : null;
}

const btn = "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-control border text-meta no-underline";

export function InvoiceButtons({ v, row, screen }: { v: unknown; row?: ListRow; screen: string }) {
  const ui = useErpUi();
  const st = invoiceState(v);
  if (!st) return null;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (!st.has) {
    const add = row?.actions?.find((a) => a.id === "invoiceFile");
    return (
      <button
        type="button"
        title="No invoice PDF — add one"
        disabled={!add}
        onClick={(e) => {
          stop(e);
          if (add && row) ui.act(screen, add, row.id);
        }}
        className={cx(btn, "border-danger/40 bg-danger-soft px-2.5 font-semibold text-danger disabled:cursor-default")}
      >
        <Icon n="upload" s={14} />
        {add ? "Add PDF" : "No PDF"}
      </button>
    );
  }
  return (
    <span className="inline-flex gap-1.5" onClick={stop}>
      <a href={erpInvoicesPdfHref([st.orderNo])} target="_blank" rel="noreferrer" title="View invoice" aria-label="View invoice" className={cx(btn, "w-8 border-line bg-surface text-danger hover:bg-canvas")}>
        <Icon n="file" s={15} />
      </a>
      <a href={erpInvoicePrintHref([st.orderNo])} target="_blank" rel="noreferrer" title="Print invoice" aria-label="Print invoice" className={cx(btn, "w-8 border-line bg-surface text-body hover:bg-canvas")}>
        <Icon n="print" s={15} />
      </a>
    </span>
  );
}
