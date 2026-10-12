"use client";

import * as React from "react";
import { Input } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * PICK A CUSTOMER BY TYPING, never from a list of the whole book.
 *
 * A `<select>` of every customer meant every page that offered one shipped
 * the book to the browser on every visit — five thousand names to fill a
 * dropdown nobody scrolls. This asks `/api/search` (the same scoped read the
 * header uses) as somebody types, so the page carries nothing until it is
 * needed.
 * ------------------------------------------------------------------------- */

export type PickedCustomer = { id: string; name: string; city?: string };

export function CustomerSearchField({
  value,
  onChange,
  autoFocus,
}: {
  value: PickedCustomer | null;
  onChange: (c: PickedCustomer | null) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<{ q: string; rows: PickedCustomer[] }>({ q: "", rows: [] });
  const term = q.trim();
  const active = !value && term.length >= 2;

  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
        if (res.ok) {
          const data = (await res.json()) as { customers?: PickedCustomer[] };
          setHits({ q: term, rows: data.customers ?? [] });
        }
      } catch {
        /* aborted */
      }
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, active]);

  if (value) {
    return (
      <div className="flex h-8.5 items-center justify-between rounded-[4px] border border-line bg-canvas px-2.5 text-sm text-ink">
        <span className="min-w-0 truncate">
          {value.name}
          {value.city ? <span className="text-muted"> · {value.city}</span> : null}
        </span>
        <button type="button" onClick={() => onChange(null)} className="ml-2 flex-none cursor-pointer text-[13px] text-brand hover:underline">
          Change
        </button>
      </div>
    );
  }

  const shown = active && hits.q === term ? hits.rows : [];
  return (
    <div className="relative">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Type a name or phone number"
        autoFocus={autoFocus}
      />
      {active ? (
        <div className="absolute top-10 left-0 z-50 max-h-64 w-full overflow-y-auto rounded-[6px] border border-line bg-surface py-1 shadow-[0_4px_16px_rgba(22,22,22,0.08)]">
          {shown.length ? (
            shown.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onChange(c);
                  setQ("");
                }}
                className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-[7px] text-left hover:bg-canvas"
              >
                <span className="min-w-0 truncate text-sm font-medium text-ink">{c.name}</span>
                {c.city ? <span className="flex-none text-[13px] text-muted">{c.city}</span> : null}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-[13px] text-muted">{hits.q === term ? "No customer matches that." : "Searching…"}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
