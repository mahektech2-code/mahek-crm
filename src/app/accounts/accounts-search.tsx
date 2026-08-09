"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { money } from "@/lib/format";
import { AccountsIcon } from "./icons";

type Hit = {
  customerId: string;
  customerName: string;
  matchedOn: string;
  outstanding: number;
  openBills: number;
};

/* ---------------------------------------------------------------------------
 * The header search.
 *
 * One box over every way a payment names its customer — the company, a bill
 * number, the order number quoted down the phone, the reference on a transfer
 * — because that is how the question arrives at this desk. All of them land on
 * a customer, and a customer's account is the answer to nearly every question
 * somebody walks over to ask.
 *
 * It does NOT jump you somewhere on the second keystroke. Being moved off the
 * screen you were working on, mid-word, is how a half-typed receipt gets lost.
 * ------------------------------------------------------------------------- */
export function AccountsSearch() {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [remote, setRemote] = React.useState<{ q: string; hits: Hit[] } | null>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/payments/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = (await res.json()) as { hits: Hit[] };
        // Tagged with the query that produced it, so a slow answer for an
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

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const q = query.trim();
  const hits = q.length < 2 ? null : remote && remote.q === q ? remote.hits : null;

  return (
    <div ref={boxRef} className="relative min-w-[180px] flex-[1_1_400px] sm:max-w-[400px]">
      <span className="pointer-events-none absolute top-[9px] left-2.5 text-muted">
        <AccountsIcon name="search" size={16} />
      </span>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search customers, bills, references…   /"
        aria-label="Search customers, bills and references"
        className="h-8.5 w-full rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm text-ink focus:border-brand focus:bg-surface focus:outline-none"
      />

      {open && q.length >= 2 ? (
        <div className="animate-fade-in absolute top-10 left-0 z-50 w-[420px] overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]">
          {/* Three sentences, never one. "Wait" and "we have nothing" must not
              look alike to somebody reading it with a customer on the phone. */}
          {hits === null ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">Searching…</p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">
              Nothing matched “{q}”. Try the customer name, or the bill number as it
              is printed.
            </p>
          ) : (
            <ul>
              {hits.map((hit) => (
                <li key={hit.customerId}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setQuery("");
                      router.push(`/accounts/ledger?customer=${hit.customerId}`);
                    }}
                    className="flex w-full cursor-pointer items-center gap-3 border-b border-canvas px-4 py-2.5 text-left last:border-0 hover:bg-canvas"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {hit.customerName}
                      </span>
                      <span className="block text-xs text-muted">
                        {hit.matchedOn} ·{" "}
                        {hit.openBills
                          ? `${hit.openBills} open bill${hit.openBills === 1 ? "" : "s"}`
                          : "nothing open"}
                      </span>
                    </span>
                    <span className="flex-none text-[13px] tabular-nums text-ink">
                      {hit.outstanding > 0 ? money(hit.outstanding) : "—"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
