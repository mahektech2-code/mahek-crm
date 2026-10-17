"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/* ---------------------------------------------------------------------------
 * EVERY FULL-SCREEN OVERLAY IS MOUNTED ON <body>, and this is why.
 *
 * A z-index only ranks an element inside its nearest stacking context. Every
 * app header is `relative z-2` or `z-30`, so a dialog opened from a header
 * button — Ask about the team, Tell us, the search — was ranked inside the
 * header and drawn at 2 against <main>. The Live map's zoom buttons (MapLibre's
 * own z-2, later in the document) and its Full screen button (z-10) came
 * straight through the scrim and sat on top of the drawer. The same happens to
 * a modal opened from anything with a transform, an opacity animation or a z
 * of its own. Raising the dialog's z-index cannot fix it; leaving the context
 * can.
 *
 * Before hydration there is no `document`, so the first render is inline —
 * exactly what the server sent — and the overlay moves to <body> on the next
 * commit. `useSyncExternalStore` is how that is said without an effect that
 * sets state, which the React Compiler rules refuse.
 * ------------------------------------------------------------------------- */

const noop = () => () => {};

export function BodyPortal({ children }: { children: React.ReactNode }) {
  const mounted = React.useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return mounted ? createPortal(children, document.body) : <>{children}</>;
}
