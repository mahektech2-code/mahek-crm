"use client";

import { Button } from "@/components/ui/primitives";

/** Opens the browser's print dialog, which also saves the PO as a PDF. */
export function PrintButton() {
  return (
    <Button variant="primary" onClick={() => window.print()}>
      Print or save as PDF
    </Button>
  );
}
