"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The filter row above every insight: one row, each a labelled select, all
 * held in the URL so a view can be shared and the page stays a server render.
 */
export function Picks({ picks }: { picks: { k: string; label: string; value: string; opts: { v: string; l: string }[] }[] }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp.toString());
    if (v) n.set(k, v);
    else n.delete(k);
    router.push(`${path}${n.size ? `?${n}` : ""}`);
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {picks.map((p) => (
        <label key={p.k} className="flex h-9 items-center gap-2 rounded-[4px] border border-line bg-surface pr-1 pl-3 text-sm">
          <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{p.label}</span>
          <select value={p.value} onChange={(e) => set(p.k, e.target.value)} className="h-7 max-w-[260px] cursor-pointer border-0 bg-transparent pr-1 text-sm text-heading outline-none">
            {p.opts.map((o) => (
              <option key={o.v} value={o.v}>
                {o.l}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
