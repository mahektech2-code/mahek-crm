"use client";

import * as React from "react";

/**
 * Whether a screen is drawn inside the CRM's Leads frame.
 *
 * The frame already names the area, the desk and the tab, so inside it a
 * screen's own title, its explanatory subtitle, a banner's paragraph and the
 * old per-section tab strip are repeats. The pieces read this and drop them.
 * Outside the frame — the Sales Dashboard mounts the same screens — it is
 * false and nothing changes.
 */
const InLeadHub = React.createContext(false);

export function LeadHubChrome({ children }: { children: React.ReactNode }) {
  return <InLeadHub.Provider value={true}>{children}</InLeadHub.Provider>;
}

export function useInLeadHub(): boolean {
  return React.useContext(InLeadHub);
}

/** What a screen draws only outside the Leads frame — its own way back to a desk the frame already shows. */
export function OutsideLeadHub({ children }: { children: React.ReactNode }) {
  return useInLeadHub() ? null : <>{children}</>;
}
