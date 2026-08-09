"use client";

import * as React from "react";
import { money } from "@/lib/format";
import { AccountsIcon } from "./icons";

export type Hit = {
  customerId: string;
  customerName: string;
  /** Why this customer matched — a bill number, an order number, a UTR. */
  matchedOn: string;
  outstanding: number;
  openBills: number;
};

/**
 * The box both money screens start from.
 *
 * A payment arrives named by whatever the payer had to hand — the company, the
 * bill, the order number, the UTR — and all four have to land on the same
 * customer, because a customer is what the next screen needs.
 */
export function CustomerSearch({
  title,
  hint,
  placeholder,
  onPick,
}: {
  title: string;
  hint: string;
  placeholder: string;
  onPick: (hit: Hit) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [remote, setRemote] = React.useState<{ q: string; hits: Hit[] } | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    // Too short to search. The last result is left where it is rather than
    // cleared — the render below never reads it while the box is this short.
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
    <div className="max-w-[720px] overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="border-b border-divider px-5 py-4">
        <div className="text-lg leading-6 font-semibold text-ink">{title}</div>
        <div className="mt-0.5 text-[13px] text-pretty text-muted">{hint}</div>
        <div className="relative mt-3">
          <span className="pointer-events-none absolute top-[11px] left-2.5 text-muted">
            <AccountsIcon name="search" size={16} />
          </span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={title}
            className="h-9.5 w-full rounded-[4px] border border-line bg-surface pr-3 pl-8 text-[15px] focus:border-brand focus:outline-none"
          />
        </div>
      </div>

      {/* Three different sentences. A list that means "wait" and one that means
          "we have nothing" must never look alike. */}
      {q.length < 2 ? (
        <p className="px-5 py-8 text-center text-sm text-muted">
          Type at least two characters.
        </p>
      ) : hits === null ? (
        <p className="px-5 py-8 text-center text-sm text-muted">Searching…</p>
      ) : hits.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-pretty text-muted">
          Nothing matched “{q}”. Try the customer name, or the bill number as it is
          printed.
        </p>
      ) : (
        <ul>
          {hits.map((hit) => (
            <li key={hit.customerId}>
              <button
                type="button"
                onClick={() => onPick(hit)}
                className="flex w-full cursor-pointer items-center gap-4 border-t border-canvas px-4 py-3 text-left first:border-t-0 hover:bg-canvas"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {hit.customerName}
                  </span>
                  <span className="mt-px block text-[13px] text-muted">
                    {hit.matchedOn} ·{" "}
                    {hit.openBills
                      ? `${hit.openBills} open bill${hit.openBills === 1 ? "" : "s"}`
                      : "nothing open"}
                  </span>
                </span>
                <span
                  className={
                    hit.outstanding > 0
                      ? "flex-none text-sm font-medium tabular-nums whitespace-nowrap text-danger"
                      : "flex-none text-sm tabular-nums whitespace-nowrap text-muted"
                  }
                >
                  {hit.outstanding > 0 ? money(hit.outstanding) : "—"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
