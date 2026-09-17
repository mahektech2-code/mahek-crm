"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { phoneDisplay } from "@/lib/format";
import { SalesIcon } from "./icons";
import { CustomerQuickView } from "./customer-quick-view";

/* ---------------------------------------------------------------------------
 * THE HEADER SEARCH, WHICH USED TO BE A PICTURE OF ONE.
 *
 * The input had no `value`, no `onChange` and no form behind it: it was in the
 * header of every screen in this app, on every navigation, and typing in it did
 * nothing whatever. It is the first thing somebody reaches for on a console
 * with thirty destinations, and it was the one control on the page that was
 * plainly broken.
 *
 * **A salesman opens his record; a shop opens the quick view.** Those are the
 * two things this app can actually show, so those are the two things offered —
 * the placeholder used to promise orders and bills as well, and neither has a
 * screen here to land on. The quick view is the SAME drawer the two maps open,
 * reading the same endpoint, so a figure found through search cannot disagree
 * with the same figure found by clicking a pin.
 * ------------------------------------------------------------------------- */

type Results = {
  salesmen: Array<{
    id: string;
    name: string;
    phone: string | null;
    active: boolean;
    customerCount: number;
  }>;
  customers: Array<{ id: string; name: string; city: string; phone: string }>;
};

const EMPTY: Results = { salesmen: [], customers: [] };

export function SalesSearch() {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [results, setResults] = React.useState<Results>(EMPTY);
  const [quickView, setQuickView] = React.useState<string | null>(null);

  /* "/" focuses it from anywhere that is not already a text field — the same
     key the CRM's search answers to, because a shortcut that works in one app
     and not the one beside it is one people stop using. */
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
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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
        const res = await fetch(`/api/sales/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (res.ok) setResults((await res.json()) as Results);
      } catch {
        /* aborted */
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, active]);

  /* Stale results from a previous query must never show under a short one. */
  const shown = active ? results : EMPTY;
  const nothing = active && !shown.salesmen.length && !shown.customers.length;
  const first = shown.salesmen[0];

  const openSalesman = (id: string) => {
    setOpen(false);
    setQuery("");
    router.push(`/sales/people/${id}`);
  };

  const openShop = (id: string) => {
    setOpen(false);
    setQuery("");
    setQuickView(id);
  };

  return (
    <>
      <div ref={wrapRef} className="relative min-w-[180px] max-w-[380px] flex-[1_1_320px]">
        <span className="pointer-events-none absolute top-[9px] left-2.5 flex text-muted">
          <SalesIcon name="search" size={16} />
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && first) openSalesman(first.id);
          }}
          placeholder="Search a salesman or a shop   /"
          aria-label="Search"
          className="h-8.5 w-full rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm text-ink outline-none focus:border-brand focus:bg-surface"
        />

        {open && active ? (
          <div className="animate-fade-in absolute top-10 left-0 z-40 w-full min-w-[320px] rounded-[6px] border border-line bg-surface py-1.5 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
            {shown.salesmen.length ? (
              <>
                <div className="px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Salesmen
                </div>
                {shown.salesmen.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => openSalesman(s.id)}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-ink">
                      {s.name}
                      {s.active ? "" : " · closed"}
                    </span>
                    <span className="flex-none text-[13px] whitespace-nowrap text-muted">
                      {s.phone ? phoneDisplay(s.phone) : `${s.customerCount} shops`}
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {shown.customers.length ? (
              <>
                <div className="mt-1.5 border-t border-divider px-3 py-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Shops
                </div>
                {shown.customers.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => openShop(c.id)}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-ink">{c.name}</span>
                    <span className="flex-none text-[13px] whitespace-nowrap text-muted">
                      {c.city}
                      {c.phone ? ` · ${phoneDisplay(c.phone)}` : ""}
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {nothing ? (
              <div className="px-3 py-5 text-center text-sm text-muted">
                Nothing matches that. Try a salesman&rsquo;s name or work number, or a
                shop&rsquo;s name, town or telephone number.
              </div>
            ) : first ? (
              /* Only where Enter opens something. It opens the first SALESMAN,
                 so a search that matched only shops must not be told to press
                 it — a hint for a key that does nothing is worse than none. */
              <div className="mt-1.5 border-t border-divider px-3 py-2 text-[13px] text-muted">
                Press Enter to open {first.name}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <CustomerQuickView customerId={quickView} onClose={() => setQuickView(null)} />
    </>
  );
}
