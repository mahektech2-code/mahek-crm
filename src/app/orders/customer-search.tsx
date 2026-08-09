"use client";

import * as React from "react";
import { Card, CardHeader, Input } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { money } from "@/lib/format";

export type Hit = {
  customerId: string;
  customerName: string;
  /** Why this customer matched — a bill number, an order number, a UTR. */
  matchedOn: string;
  outstanding: number;
  openBills: number;
};

/**
 * The one box both accounts screens start from. A payment arrives named by
 * whatever the payer had to hand — the company, the bill, the order number,
 * the UTR — and all four have to land on the same customer.
 */
export function CustomerSearch({
  title,
  onPick,
}: {
  title: string;
  onPick: (hit: Hit) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [remote, setRemote] = React.useState<{ q: string; hits: Hit[] } | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    // Too short to search. The last result is left where it is rather than
    // cleared — the render below never reads it while the box is this short,
    // and clearing it here would be a setState the effect does not need.
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/payments/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as { hits: Hit[] };
        // Tagged with the query that produced it, so a slow response for an
        // earlier query cannot overwrite a newer one on arrival.
        setRemote({ q, hits: data.hits ?? [] });
      } catch {
        /* aborted or failed — the box stays as it was */
      }
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const q = query.trim();
  const hits = q.length < 2 ? null : remote && remote.q === q ? remote.hits : null;

  return (
    <Card className="mt-4">
      <CardHeader
        title={title}
        hint="Customer name, phone, bill number, order number, or the reference on the transfer"
      />
      <div className="px-4 pb-4">
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
            <Icon name="search" />
          </span>
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Shree Paints, MM/2026/4021, SHEET-1183, UTR904312…"
            className="pl-9"
            aria-label="Search for a customer, bill, order or reference"
          />
        </div>

        <div className="mt-3">
          {/* Three different sentences. Mid-call, a list that means "wait" and
              one that means "we have nothing" must never look alike. */}
          {q.length < 2 ? (
            <p className="py-6 text-center text-[13px] text-muted">
              Type at least two characters.
            </p>
          ) : hits === null ? (
            <p className="py-6 text-center text-[13px] text-muted">Searching…</p>
          ) : hits.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted">
              Nothing matched “{q}”. Try the customer name, or the bill number as
              it is printed.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {hits.map((hit) => (
                <li key={hit.customerId}>
                  <button
                    type="button"
                    onClick={() => onPick(hit)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-canvas"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">
                        {hit.customerName}
                      </span>
                      <span className="block text-[12px] text-muted">
                        {hit.matchedOn} ·{" "}
                        {hit.openBills
                          ? `${hit.openBills} open bill${hit.openBills === 1 ? "" : "s"}`
                          : "nothing open"}
                      </span>
                    </span>
                    <span className="tabular-nums text-[13px] text-ink">
                      {money(hit.outstanding)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
