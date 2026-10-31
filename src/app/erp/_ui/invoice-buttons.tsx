"use client";

import { useState } from "react";
import type { ListRow } from "@/lib/erp/ui";
import { cx } from "@/components/ui/primitives";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";
import { InvoiceModal } from "./invoice-modals";

/* ---------------------------------------------------------------------------
 * An order's invoice, as buttons: view and print where its PDF is attached,
 * a red Add PDF where it is billed without one. Drawn in each order's group
 * heading. Both open the invoice in a pop-up on this page — never a new tab —
 * and print opens the print dialog as soon as the pages are read.
 * ------------------------------------------------------------------------- */

export function invoiceState(v: unknown): { has: boolean; orderNo: number } | null {
  const m = /^([yn]):(\d+)$/.exec(String(v ?? ""));
  return m ? { has: m[1] === "y", orderNo: Number(m[2]) } : null;
}

const btn = "inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-control border text-meta";

export function InvoiceButtons({ v, row, screen }: { v: unknown; row?: ListRow; screen: string }) {
  const ui = useErpUi();
  const [open, setOpen] = useState<null | "view" | "print">(null);
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
  const party = row ? String(row.v.billing ?? "") || null : null;
  const transporter = row ? (String(row.v.transporter ?? "").replace(/^—$/, "") || null) : null;
  return (
    <span className="inline-flex gap-1.5" onClick={stop}>
      <button type="button" title="View invoice" aria-label="View invoice" onClick={() => setOpen("view")} className={cx(btn, "w-8 border-line bg-surface text-danger hover:bg-canvas")}>
        <Icon n="file" s={15} />
      </button>
      <button type="button" title="Print invoice" aria-label="Print invoice" onClick={() => setOpen("print")} className={cx(btn, "w-8 border-line bg-surface text-body hover:bg-canvas")}>
        <Icon n="print" s={15} />
      </button>
      {open ? <InvoiceModal orderNo={st.orderNo} party={party} transporter={transporter} autoPrint={open === "print"} onClose={() => setOpen(null)} /> : null}
    </span>
  );
}
