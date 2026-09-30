"use client";

import { Button } from "@/components/ui/primitives";

/** The browser's print dialog — the page's print styles leave only the sheet. */
export function PrintButton() {
  return (
    <Button variant="primary" onClick={() => window.print()}>
      Print
    </Button>
  );
}
