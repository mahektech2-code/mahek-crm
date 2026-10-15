"use client";

import { useEffect } from "react";

/** Opens the print dialog once the label has drawn. */
export function PrintOnOpen() {
  useEffect(() => {
    const t = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}
