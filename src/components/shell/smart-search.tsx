"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SalesIcon } from "@/components/console/icons";
import { cx } from "@/components/ui/primitives";
import { askAi } from "./ask-panel";
import { looksLikeQuestion, type SearchHit } from "@/lib/search-hit";

/* ---------------------------------------------------------------------------
 * ONE BOX TO FIND A THING OR ASK ABOUT IT — the ERP header's search, shared.
 *
 * What is typed is searched as it is typed: one flat list, grouped by what
 * each row is (customer, lead, bill, order, complaint, salesman, product,
 * screen) and opened by choosing it. Where the app has an Ask AI drawer the
 * same text can be asked instead: the first row offers it, it moves to the top
 * and Enter asks it when what was typed reads as a question ("who owes the
 * most?"), and choosing it opens the drawer with the answer already coming.
 *
 * The keyboard is the point on a desk where people type all day: "/" focuses
 * the box from anywhere, ↑ ↓ move, Enter opens, Esc closes.
 * ------------------------------------------------------------------------- */

type Row = { type: "ask" } | { type: "hit"; hit: SearchHit };

export function SmartSearch({
  endpoint,
  placeholder,
  ask,
  onQuick,
  className,
}: {
  /** GET `?q=` → `{ hits: SearchHit[] }`. */
  endpoint: string;
  placeholder: string;
  /** The app's Ask AI drawer is mounted, under this name ("Ask the CRM"). */
  ask?: string;
  /** Open a customer in the app's own quick view (a hit carrying `quick`). */
  onQuick?: (customerId: string) => void;
  className?: string;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<{ q: string; hits: SearchHit[] }>({ q: "", hits: [] });
  const [active, setActive] = React.useState(0);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", handler);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", handler);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const term = query.trim();
  const searching = term.length >= 2;

  React.useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${endpoint}?q=${encodeURIComponent(term)}`, { signal: controller.signal });
        if (res.ok) {
          const j = (await res.json()) as { hits?: SearchHit[] };
          setResult({ q: term, hits: j.hits ?? [] });
          setActive(0);
        }
      } catch {
        /* aborted */
      }
    }, 160);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, searching, endpoint]);

  /* Stale results from a previous query never show under a different one. */
  const fresh = searching && result.q === term;
  const hits = fresh ? result.hits : [];
  const question = Boolean(ask) && looksLikeQuestion(term);
  const offerAsk = Boolean(ask) && term.length >= 3;
  const rows: Row[] = [
    ...(offerAsk && question ? [{ type: "ask" as const }] : []),
    ...hits.filter((h) => h.href || h.quick).map((hit) => ({ type: "hit" as const, hit })),
    ...(offerAsk && !question ? [{ type: "ask" as const }] : []),
  ];

  const reset = () => {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.type === "ask") {
      askAi(term);
      reset();
      return;
    }
    const { hit } = row;
    if (hit.quick && onQuick) {
      onQuick(hit.quick);
      reset();
    } else if (hit.href) {
      reset();
      router.push(hit.href);
    }
  };

  /* Sections in the order the server ranked them; info-only rows (products)
     are drawn in their section but never take the keyboard. */
  const sections: Array<{ kind: string; hits: SearchHit[] }> = [];
  for (const h of hits) {
    const last = sections[sections.length - 1];
    if (last && last.kind === h.kind) last.hits.push(h);
    else sections.push({ kind: h.kind, hits: [h] });
  }
  const indexOf = (h: SearchHit) => rows.findIndex((r) => r.type === "hit" && r.hit === h);
  const askIndex = rows.findIndex((r) => r.type === "ask");

  const askRow = (
    <button
      type="button"
      onMouseEnter={() => setActive(askIndex)}
      onClick={() => choose({ type: "ask" })}
      className={cx(
        "flex w-full cursor-pointer items-center gap-2.5 px-3 py-[8px] text-left text-sm",
        active === askIndex ? "bg-brand-soft" : "hover:bg-canvas",
      )}
    >
      <span className="flex flex-none text-[#5223E0]">
        <SalesIcon name="spark" size={15} />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-[#5223E0]">{ask}</span>
        <span className="text-body">: “{term}”</span>
      </span>
      {active === askIndex ? <Kbd>Enter</Kbd> : null}
    </button>
  );

  return (
    <div ref={wrapRef} className={cx("relative min-w-[200px] flex-[1_1_420px]", className ?? "max-w-[460px]")}>
      <span className="pointer-events-none absolute top-[9px] left-2.5 flex text-muted">
        <SalesIcon name="search" size={16} />
      </span>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, Math.max(rows.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(rows[active] ?? rows[0]);
          } else if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        placeholder={placeholder}
        aria-label="Search"
        className="h-8.5 w-full rounded-[4px] border border-line bg-canvas pr-9 pl-8 text-sm text-ink outline-none focus:border-brand focus:bg-surface"
      />
      {!query ? (
        <span className="pointer-events-none absolute top-[7px] right-2">
          <Kbd>/</Kbd>
        </span>
      ) : null}

      {open && (searching || offerAsk) ? (
        <div className="animate-fade-in absolute top-10 left-0 z-40 w-full min-w-[360px] overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_4px_16px_rgba(22,22,22,0.08)]">
          <div className="max-h-[min(70vh,520px)] overflow-y-auto py-1.5">
            {offerAsk && question ? askRow : null}

            {sections.map((s, si) => (
              <div key={s.kind} className={cx((si > 0 || (offerAsk && question)) && "mt-1 border-t border-divider pt-1")}>
                <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  {heading(s.kind)}
                </div>
                {s.hits.map((h) => {
                  const i = indexOf(h);
                  const body = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{h.name}</span>
                        {h.meta ? <span className="block truncate text-[13px] text-muted">{h.meta}</span> : null}
                      </span>
                      {i >= 0 && i === active ? <Kbd>Enter</Kbd> : null}
                    </>
                  );
                  return i < 0 ? (
                    <div key={`${h.kind}:${h.name}`} className="flex w-full items-center gap-3 px-3 py-[6px]">
                      {body}
                    </div>
                  ) : (
                    <button
                      type="button"
                      key={`${h.kind}:${h.href ?? h.quick}:${h.name}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(rows[i])}
                      className={cx(
                        "flex w-full cursor-pointer items-center gap-3 px-3 py-[6px] text-left",
                        i === active ? "bg-canvas" : "hover:bg-canvas",
                      )}
                    >
                      {body}
                    </button>
                  );
                })}
              </div>
            ))}

            {searching && !fresh && !hits.length ? (
              <div className="px-3 py-3 text-[13px] text-muted">Searching…</div>
            ) : null}
            {fresh && !hits.length ? (
              <div className="px-3 py-4 text-center text-[13px] text-muted">
                Nothing you can open matches “{term}”.
                {ask ? " Ask it as a question instead." : " Try a name, a phone number or a number."}
              </div>
            ) : null}

            {offerAsk && !question ? <div className="mt-1 border-t border-divider pt-1">{askRow}</div> : null}
          </div>
          <div className="flex items-center gap-3 border-t border-divider bg-canvas px-3 py-1.5 text-[11px] text-muted">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd> open
            </span>
            {ask ? <span>End with ? to ask AI</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A section's heading: the kind, made plural ("Boxes", "Packing batches"). */
function heading(kind: string): string {
  if (kind === "Third party") return "Third-party customers";
  if (kind === "Screen") return "Go to";
  if (/(PO|PR)$/.test(kind)) return `${kind}s`;
  if (/(s|x|ch|sh)$/i.test(kind)) return `${kind}es`;
  return `${kind}s`;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-[3px] border border-line bg-surface px-1 font-sans text-[11px] text-muted">
      {children}
    </kbd>
  );
}
