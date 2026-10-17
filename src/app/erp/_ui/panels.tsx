"use client";

import type { ListRow } from "@/lib/erp/ui";

/* ---------------------------------------------------------------------------
 * Panels a screen draws inside its record drawer, keyed by kind: lot
 * allocation on an order line, test evidence on a purchase test, the lots of a
 * packing batch, the trace of a bill. Each phase registers its own.
 * ------------------------------------------------------------------------- */

export type PanelProps = { data: unknown; row: ListRow; screen: string };
type PanelComponent = (p: PanelProps) => React.ReactNode;

const PANELS: Record<string, PanelComponent> = {};

export function registerPanel(kind: string, c: PanelComponent) {
  PANELS[kind] = c;
}

/** Draws a registered panel — called as a function, so no component is created during render. */
export function renderPanel(kind: string, props: PanelProps): React.ReactNode {
  const fn = PANELS[kind];
  return fn ? fn(props) : null;
}
