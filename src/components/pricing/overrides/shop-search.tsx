"use client";

/* ---------------------------------------------------------------------------
 * FIND A SHOP — the search box behind "New override" and "What a shop pays".
 * The same endpoint the scope editor and the list preview ask, so a shop the
 * reader may not see is not offered here either.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { Input } from "@/components/ui/primitives";
import type { CustomerHit } from "@/lib/price-list-views";

export function ShopSearch({
  onPick,
  placeholder = "Type a shop's name, city or phone…",
  autoFocus,
}: {
  onPick: (hit: CustomerHit) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<{ q: string; rows: CustomerHit[] } | null>(null);

  React.useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/price-lists/customers/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const data = (await res.json()) as { customers?: CustomerHit[] };
        setHits({ q, rows: data.customers ?? [] });
      } catch {
        /* An abort is the next keystroke. */
      }
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const q = query.trim();
  const rows = q && hits && hits.q === q ? hits.rows : null;
  return (
    <div>
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} />
      {q ? (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-[4px] border border-line">
          {rows == null ? (
            <div className="px-3 py-2 text-[13px] text-muted">Searching…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-muted">No shop matches “{q}”.</div>
          ) : (
            rows.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => onPick(h)}
                className="block w-full cursor-pointer border-b border-line px-3 py-2 text-left text-sm last:border-b-0 hover:bg-canvas"
              >
                <span className="text-ink">{h.name}</span>
                <span className="ml-2 text-[12px] text-muted">
                  {h.city}
                  {h.region ? `, ${h.region}` : ""}
                  {h.kind === "lead" ? " · lead" : ""}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
