"use client";

import dynamic from "next/dynamic";

/* ---------------------------------------------------------------------------
 * The call drawer, loaded when it is first drawn rather than with the page.
 *
 * It is the largest client component in the CRM — the form, the order lines,
 * the payment fields, the assistant — and the Call Log and a customer record
 * both shipped all of it before anybody had pressed Call. Types still come
 * from `./call-panel`; only the component crosses this boundary.
 * ------------------------------------------------------------------------- */
export const CallPanel = dynamic(
  () => import("./call-panel").then((m) => m.CallPanel),
  { ssr: false },
);
