"use client";

import * as React from "react";
import { SmartSearch } from "@/components/shell/smart-search";
import { SALES_ASK } from "@/components/shell/ask-setups";
import { CustomerQuickView } from "@/components/console/customer-quick-view";

/* ---------------------------------------------------------------------------
 * THE SALES DASHBOARD'S HEADER SEARCH — the ERP's box, shared.
 *
 * One list: a salesman opens his record, a shop opens the quick view (the SAME
 * drawer the two maps open, reading the same endpoint, so a figure found
 * through search cannot disagree with the same figure found by clicking a
 * pin), a lead opens its record, and a screen opens itself. Typed as a
 * question, the same box asks the team — "Ask about the team" opens with the
 * answer already coming.
 * ------------------------------------------------------------------------- */
export function SalesSearch() {
  const [quickView, setQuickView] = React.useState<string | null>(null);
  return (
    <>
      <SmartSearch
        endpoint="/api/sales/search"
        placeholder="Search salesmen, shops, leads — or ask about the team"
        ask={SALES_ASK.title}
        onQuick={setQuickView}
        className="max-w-[420px]"
      />
      <CustomerQuickView customerId={quickView} onClose={() => setQuickView(null)} />
    </>
  );
}
