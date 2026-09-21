"use client";

/* ---------------------------------------------------------------------------
 * The one interactive thing on a printable page.
 *
 * The print sheet is a server component — it is Mahek's own letterhead over
 * the list's own rates and nothing on it changes — so the button that opens
 * the browser's print dialog is the only piece that has to be a client. It is
 * `print:hidden`, because a button drawn on the paper is the one thing a
 * printed price list must not carry.
 * ------------------------------------------------------------------------- */

import { Button } from "@/components/ui/primitives";

export function PrintButton() {
  return (
    <div className="print:hidden">
      <Button variant="primary" onClick={() => window.print()}>
        Print
      </Button>
    </div>
  );
}
