"use client";

import { NavLink } from "@/components/shell/nav-link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DispatchQueueRow } from "@/lib/erp/dispatch";
import { erpDispatchHref } from "@/lib/erp/trace-links";
import { fd, nf } from "@/lib/erp/ui";
import { Card, cx, EmptyState, Input } from "@/components/ui/primitives";
import { MultiSelect } from "@/components/ui/multi-select";
import { Icon } from "../_ui/icons";
import { fieldLabelClass, LinkButton, toggleClass } from "../_ui/look";

/* ---------------------------------------------------------------------------
 * THE QUEUE, FOUND BY WHAT SOMEBODY KNOWS. A loader knows the shop, the
 * lorry or what is in the boxes; the order number is the one thing they
 * usually do not have, and typing it was the only way in. One box searches
 * every word on a card — party, billed-to, area, transporter, product,
 * number — and the Filter button narrows by the questions a desk asks, each
 * a multi-select. The list itself is the answer: pick a card and scan.
 *
 * Everything is filtered here, over the queue the page already read: it is
 * one row per waiting order, and a round trip per keystroke would buy
 * nothing but a slower list.
 * ------------------------------------------------------------------------- */

type Facets = { godown: string[]; leaves: string[]; billing: string[]; scanning: string[]; transporter: string[]; area: string[]; product: string[] };
const NONE: Facets = { godown: [], leaves: [], billing: [], scanning: [], transporter: [], area: [], product: [] };
const NO_TRANSPORTER = "No transporter";
const NO_AREA = "No area";

const leavesOf = (o: DispatchQueueRow, today: string) => (!o.dispatchOn ? "No date" : o.dispatchOn < today ? "Overdue" : o.dispatchOn === today ? "Today" : "Later");
const billingOf = (o: DispatchQueueRow) => (!o.billed ? "Not billed" : o.billed < o.lines ? "Part billed" : "Billed");
const scanningOf = (o: DispatchQueueRow) => {
  const target = Math.round(o.target);
  return o.scanned <= 0 ? "Not started" : target > 0 && o.scanned >= target ? "All scanned" : "Part scanned";
};

/** Every value a facet takes on the queue, most common first, each with its count. */
function optionsOf(rows: DispatchQueueRow[], pick: (o: DispatchQueueRow) => string[], order?: string[]) {
  const n = new Map<string, number>();
  for (const o of rows) for (const v of pick(o)) n.set(v, (n.get(v) ?? 0) + 1);
  const keys = order ? order.filter((k) => n.has(k)) : [...n.keys()].sort((a, b) => n.get(b)! - n.get(a)! || a.localeCompare(b));
  return keys.map((k) => ({ value: k, label: `${k} · ${nf(n.get(k)!)}` }));
}

export function DispatchQueue({ queue, current, today }: { queue: DispatchQueueRow[]; current: number | null; today: string }) {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Facets>(NONE);

  const pickers: { k: keyof Facets; l: string; of: (o: DispatchQueueRow) => string[]; order?: string[] }[] = [
    { k: "leaves", l: "Leaves", of: (o) => [leavesOf(o, today)], order: ["Overdue", "Today", "Later", "No date"] },
    { k: "billing", l: "Billing", of: (o) => [billingOf(o)], order: ["Billed", "Part billed", "Not billed"] },
    { k: "scanning", l: "Boxes scanned", of: (o) => [scanningOf(o)], order: ["Not started", "Part scanned", "All scanned"] },
    { k: "godown", l: "Godown", of: (o) => [o.godown] },
    { k: "transporter", l: "Transporter", of: (o) => [o.transporter ?? NO_TRANSPORTER] },
    { k: "area", l: "Area", of: (o) => [o.area ?? NO_AREA] },
    { k: "product", l: "Product", of: (o) => o.products },
  ];
  const options = Object.fromEntries(pickers.map((p) => [p.k, optionsOf(queue, p.of, p.order)])) as Record<keyof Facets, { value: string; label: string }[]>;

  const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = queue.filter((o) => {
    for (const p of pickers) if (f[p.k].length && !p.of(o).some((v) => f[p.k].includes(v))) return false;
    if (!words.length) return true;
    const hay = [String(o.orderNo), o.delivery, o.billing, o.area ?? "", o.transporter ?? "", o.godown, ...o.products].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const on = pickers.filter((p) => f[p.k].length).length;

  /* Enter opens the order when the answer is one: a typed number that is on the queue, or the only card left. */
  const go = () => {
    const no = /^\d+$/.test(term.trim()) ? Number(term.trim()) : null;
    if (no != null && !queue.some((o) => o.orderNo === no)) return router.push(erpDispatchHref(no));
    const hit = no != null ? queue.find((o) => o.orderNo === no) : shown.length === 1 ? shown[0] : null;
    if (hit) router.push(erpDispatchHref(hit.orderNo));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-2">
        <span className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint">
            <Icon n="search" s={15} />
          </span>
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                go();
              }
            }}
            autoFocus
            placeholder="Party, area, transporter, product or order no."
            aria-label="Find an order"
            className="h-9 w-full pl-9"
          />
        </span>
        <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className={toggleClass(on > 0, "h-9")}>
          <Icon n="filter" s={14} />
          Filter
          {on ? <span className="rounded-full bg-brand px-1.5 text-2xs font-semibold text-white tabular-nums">{on}</span> : null}
        </button>
      </div>

      {open ? (
        <Card className="flex flex-col gap-2.5 px-3 py-3">
          {pickers.map((p) => (
            <label key={p.k} className="flex flex-col gap-1">
              <span className={fieldLabelClass}>{p.l}</span>
              <MultiSelect label={p.l} options={options[p.k]} selected={f[p.k]} onChange={(next) => setF({ ...f, [p.k]: next })} className={cx(f[p.k].length > 0 && "border-brand bg-brand-soft")} />
            </label>
          ))}
          {on ? (
            <LinkButton onClick={() => setF(NONE)} className="self-start">
              Clear filters
            </LinkButton>
          ) : null}
        </Card>
      ) : null}

      {on || words.length ? (
        <div className="flex items-center justify-between px-0.5 text-meta text-muted">
          <span>
            {nf(shown.length)} of {nf(queue.length)} orders
          </span>
          <LinkButton
            onClick={() => {
              setTerm("");
              setF(NONE);
            }}
          >
            Show all
          </LinkButton>
        </div>
      ) : null}

      {shown.length ? (
        shown.map((o) => {
          const done = o.target > 0 && o.scanned >= Math.round(o.target);
          const pct = o.target ? Math.min(100, Math.round((100 * o.scanned) / o.target)) : 0;
          return (
            <NavLink
              key={o.orderNo}
              href={erpDispatchHref(o.orderNo)}
              aria-current={o.orderNo === current ? "page" : undefined}
              className={cx(
                "flex flex-col gap-2 rounded-[10px] border bg-surface px-3.5 py-3 text-ink no-underline hover:no-underline",
                o.orderNo === current ? "border-brand ring-3 ring-brand-soft" : "border-line hover:border-line-strong",
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold">{o.delivery}</span>
                <span className="flex-none font-mono text-xs text-faint">{o.orderNo}</span>
              </span>
              <span className="truncate text-xs text-muted">
                {o.godown} · <span className={cx(o.dispatchOn && o.dispatchOn < today ? "text-danger" : undefined)}>{o.dispatchOn ? `leaves ${fd(o.dispatchOn)}` : "no date"}</span> ·{" "}
                {o.billed ? `billed ${o.billed} of ${o.lines}` : <span className="text-warn-ink">not billed</span>}
              </span>
              {o.area || o.transporter ? <span className="truncate text-xs text-muted">{[o.area, o.transporter].filter(Boolean).join(" · ")}</span> : null}
              <span className="flex items-center gap-3">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-divider">
                  <span className={cx("block h-full rounded-full", done ? "bg-success" : "bg-brand")} style={{ width: `${pct}%` }} />
                </span>
                <span className="flex-none text-meta text-body tabular-nums">
                  {o.scanned}/{Math.round(o.target)}
                </span>
              </span>
            </NavLink>
          );
        })
      ) : (
        <Card>
          {queue.length ? (
            <EmptyState title="No waiting order matches." body="Change the words or the filters, or show every order." />
          ) : (
            <EmptyState title="No order is Ready and waiting to leave." body="A line reaches the desk once it is marked Ready on Orders." />
          )}
        </Card>
      )}
    </div>
  );
}
