"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { money, phoneDisplay } from "@/lib/format";
import { CRM_BASE } from "./nav";

type Results = {
  customers: Array<{ id: string; name: string; city: string; phone: string }>;
  bills: Array<{
    id: string;
    billNo: string;
    amount: number;
    customerId: string;
    customerName: string;
  }>;
};

const EMPTY: Results = { customers: [], bills: [] };

export function GlobalSearch() {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [results, setResults] = React.useState<Results>(EMPTY);

  // "/" focuses search from anywhere that is not already a text field.
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
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const active = query.trim().length >= 2;

  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (res.ok) setResults(await res.json());
      } catch {
        /* aborted */
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, active]);

  // Stale results from a previous query must never show under a short one.
  const shown = active ? results : EMPTY;
  const first = shown.customers[0];
  const nothing = active && !shown.customers.length && !shown.bills.length;

  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  return (
    <div ref={wrapRef} className="relative w-[400px]">
      <Icon
        name="search"
        size={16}
        className="pointer-events-none absolute top-[9px] left-2.5 text-muted"
      />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && first) go(`${CRM_BASE}/customers/${first.id}`);
        }}
        placeholder="Search customers, bills, phone numbers…   /"
        aria-label="Search"
        className="h-8.5 w-full rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm text-ink outline-none focus:border-brand focus:bg-surface"
      />

      {open && active ? (
        <div className="animate-fade-in absolute top-10 left-0 z-40 w-full rounded-[6px] border border-line bg-surface py-1.5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
          {shown.customers.length ? (
            <>
              <div className="px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Customers
              </div>
              {shown.customers.map((c) => (
                <button
                  key={c.id}
                  onClick={() => go(`${CRM_BASE}/customers/${c.id}`)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
                >
                  <span className="text-sm font-medium text-ink">{c.name}</span>
                  <span className="text-[13px] text-muted">
                    {c.city} · {phoneDisplay(c.phone)}
                  </span>
                </button>
              ))}
            </>
          ) : null}

          {shown.bills.length ? (
            <>
              <div className="mt-1.5 border-t border-divider px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Bills
              </div>
              {shown.bills.map((b) => (
                <button
                  key={b.id}
                  onClick={() => go(`${CRM_BASE}/bills?customer=${b.customerId}`)}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
                >
                  <span className="text-sm font-medium text-ink">{b.billNo}</span>
                  <span className="text-[13px] text-muted">
                    {b.customerName} · {money(b.amount)}
                  </span>
                </button>
              ))}
            </>
          ) : null}

          {nothing ? (
            <div className="px-3 py-5 text-center text-sm text-muted">
              Nothing matches that. Try a business name, a telephone number or a
              bill number.
            </div>
          ) : (
            <div className="mt-1.5 border-t border-divider px-3 py-2 text-[13px] text-muted">
              Press Enter to open the first result
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
