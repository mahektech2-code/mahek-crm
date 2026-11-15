"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/**
 * Whether a screen is drawn inside the CRM's Leads frame.
 *
 * The frame names the desk and draws its one row of tabs, so inside it a
 * screen's own title, its explanatory subtitle, a banner's paragraph and the
 * old per-section tab strip are repeats. The pieces read this and drop them.
 * Outside the frame — the Sales Dashboard mounts the same screens — it is
 * false and nothing changes.
 *
 * A screen's ACTIONS are not repeats: they belong beside the desk's title, the
 * way every other CRM page puts its buttons, so the frame offers a slot and
 * `HubActions` sends them there.
 */
const InLeadHub = React.createContext(false);
const ActionsSlot = React.createContext<HTMLElement | null>(null);

export function LeadHubChrome({
  slot = null,
  children,
}: {
  slot?: HTMLElement | null;
  children: React.ReactNode;
}) {
  return (
    <InLeadHub.Provider value={true}>
      <ActionsSlot.Provider value={slot}>{children}</ActionsSlot.Provider>
    </InLeadHub.Provider>
  );
}

export function useInLeadHub(): boolean {
  return React.useContext(InLeadHub);
}

/** A screen's buttons, beside the desk's title where there is one. */
export function HubActions({ children }: { children: React.ReactNode }) {
  const slot = React.useContext(ActionsSlot);
  if (slot) return createPortal(children, slot);
  return <div className="mb-4 flex flex-wrap items-center justify-end gap-2 print:hidden">{children}</div>;
}

/** What a screen draws only outside the Leads frame — its own way back to a desk the frame already shows. */
export function OutsideLeadHub({ children }: { children: React.ReactNode }) {
  return useInLeadHub() ? null : <>{children}</>;
}
