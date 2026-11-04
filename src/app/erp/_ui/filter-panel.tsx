"use client";

import { useEffect, useState } from "react";
import { Button, checkboxClass, cx, Input } from "@/components/ui/primitives";
import { cleanDecimal, parseRupees } from "@/lib/format";
import { moneyText, nf } from "@/lib/erp/ui";
import type { ColFilter, PanelSection } from "@/lib/erp/list-query";
import { Icon } from "./icons";
import { LinkButton, popoverClass } from "./look";
import { toolbarToggleClass } from "./columns-menu";
import type { PickItem } from "./godown-picker";

/* ---------------------------------------------------------------------------
 * A LIST'S FILTERS BEHIND ONE BUTTON, AND NOTHING MOVES UNTIL APPLY.
 *
 * Every section is drawn for what it filters: a handful of values are pills
 * with their counts, more of them are a search and a tick list, a figure is a
 * from–to (rupees typed, paise sent), and the godown is one pick. Choices are
 * a DRAFT: the header says what Apply would leave ("Shows 9 of 16"), asked of
 * the server as the picks change, and Cancel leaves the list as it was. What
 * Apply writes is the list's ordinary `cf` reading, so search, export and
 * "Select all" all honour it with nothing more to teach them.
 * ------------------------------------------------------------------------- */

/** Up to this many values a section is pills; more is a search and ticks. */
const PILL_MAX = 8;
/** The most values a tick list draws at once; the search finds the rest. */
const LIST_SHOWN = 120;

/** A section's draft: the ticked values, or a typed from–to. */
type Pick = { in: string[] } | { min: string; max: string };
type Draft = { cf: Record<string, Pick>; gf: string };

const blankWord = (v: string) => (v === "—" ? "(Blank)" : v);

/** A range's bound as typed: rupees where the column is money. */
const boundText = (v: number | null | undefined, money: boolean) => (v == null ? "" : money ? String(v / 100) : String(v));
const boundValue = (s: string, money: boolean): number | null => {
  if (!s.trim()) return null;
  if (money) return parseRupees(s);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function draftOf(sections: PanelSection[], cf: Record<string, ColFilter>, fx: Record<string, string>, gf: string): Draft {
  const out: Record<string, Pick> = {};
  for (const s of sections) {
    const f = cf[s.k];
    if (s.kind === "list") out[s.k] = { in: f?.in ?? (fx[s.k] ? [fx[s.k]] : []) };
    else out[s.k] = { min: boundText(f?.min, s.money), max: boundText(f?.max, s.money) };
  }
  return { cf: out, gf };
}

/** The `cf` a draft is applied as. Filters on columns the pop-up does not show are kept as they were. */
export function draftToCf(sections: PanelSection[], draft: Draft, cf: Record<string, ColFilter>): Record<string, ColFilter> {
  const out: Record<string, ColFilter> = { ...cf };
  for (const s of sections) {
    delete out[s.k];
    const p = draft.cf[s.k];
    if (!p) continue;
    if ("in" in p) {
      if (p.in.length) out[s.k] = { in: p.in };
    } else if (s.kind === "range") {
      const min = boundValue(p.min, s.money);
      const max = boundValue(p.max, s.money);
      if (min != null || max != null) out[s.k] = { min, max };
    }
  }
  return out;
}

/** How many filters a reading has on — the number on the button. */
export function filtersOn(cf: Record<string, ColFilter>, fx: Record<string, string>, gf: string): number {
  return Object.keys(cf).length + Object.keys(fx).filter((k) => !cf[k]).length + (gf ? 1 : 0);
}

export function FilterPanel({
  sections,
  cf,
  fx,
  gf,
  godowns,
  placeOne,
  placeMany,
  count,
  onApply,
}: {
  sections: PanelSection[];
  cf: Record<string, ColFilter>;
  fx: Record<string, string>;
  gf: string;
  /** The godown section's choices; null where the list has no godown. */
  godowns: PickItem[] | null;
  placeOne: string;
  placeMany: string;
  /** What a draft would leave, asked as the picks change. */
  count: (cf: Record<string, ColFilter>, gf: string) => Promise<{ n: number; of: number } | null>;
  onApply: (cf: Record<string, ColFilter>, gf: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const on = filtersOn(cf, fx, gf);
  if (!sections.length && !(godowns && godowns.length > 1)) return null;
  return (
    <span className="relative inline-block flex-none">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={toolbarToggleClass(on > 0)}>
        <Icon n="filter" s={14} />
        Filters
        {on ? <span className="rounded-full bg-brand px-1.5 text-2xs font-semibold text-white tabular-nums">{on}</span> : null}
      </button>
      {open ? (
        <Panel
          sections={sections}
          initial={draftOf(sections, cf, fx, gf)}
          cf={cf}
          godowns={godowns}
          placeOne={placeOne}
          placeMany={placeMany}
          count={count}
          onClose={() => setOpen(false)}
          onApply={(next, g) => {
            setOpen(false);
            onApply(next, g);
          }}
        />
      ) : null}
    </span>
  );
}

function Panel({
  sections,
  initial,
  cf,
  godowns,
  placeOne,
  placeMany,
  count,
  onClose,
  onApply,
}: {
  sections: PanelSection[];
  initial: Draft;
  cf: Record<string, ColFilter>;
  godowns: PickItem[] | null;
  placeOne: string;
  placeMany: string;
  count: (cf: Record<string, ColFilter>, gf: string) => Promise<{ n: number; of: number } | null>;
  onClose: () => void;
  onApply: (cf: Record<string, ColFilter>, gf: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [preview, setPreview] = useState<{ key: string; n: number; of: number } | null>(null);
  const next = draftToCf(sections, draft, cf);
  const key = JSON.stringify([next, draft.gf]);
  const changed = key !== JSON.stringify([draftToCf(sections, initial, cf), initial.gf]);
  useEffect(() => {
    let gone = false;
    const t = setTimeout(async () => {
      const res = await count(JSON.parse(key)[0] as Record<string, ColFilter>, draft.gf);
      if (!gone && res) setPreview({ key, ...res });
    }, 250);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [key, draft.gf, count]);
  const shown = preview && preview.key === key ? preview : null;
  const setPick = (k: string, p: Pick) => setDraft((d) => ({ ...d, cf: { ...d.cf, [k]: p } }));
  const clear = () =>
    setDraft({ gf: "", cf: Object.fromEntries(sections.map((s) => [s.k, s.kind === "list" ? { in: [] } : { min: "", max: "" }])) });

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-40" />
      <div role="dialog" aria-label="Filters" className={cx("animate-fade-in absolute top-10 left-0 z-50 flex w-[480px] max-w-[92vw] flex-col", popoverClass)}>
        <div className="flex items-center gap-2.5 px-4.5 pt-3.5 pb-3">
          <span className="text-md font-bold text-ink">Filters</span>
          <span className="text-meta text-muted tabular-nums" aria-live="polite">
            {shown ? (
              <>
                Shows <b className="font-semibold text-ink">{nf(shown.n)}</b> of {nf(shown.of)}
              </>
            ) : (
              "Counting…"
            )}
          </span>
          <span className="flex-1" />
          <LinkButton onClick={clear}>Clear all</LinkButton>
        </div>
        <div className="max-h-[min(560px,65vh)] overflow-y-auto">
          {godowns && godowns.length > 1 ? (
            <Section title={placeOne.replace(/^./, (c) => c.toUpperCase())} aside={draft.gf ? "1 picked" : `All ${placeMany}`}>
              <ListPicker
                opts={godowns.map((g) => ({ v: g.v, l: g.l, sub: g.sub }))}
                picked={draft.gf ? [draft.gf] : []}
                one
                search={`Search ${placeMany}`}
                onChange={(vs) => setDraft((d) => ({ ...d, gf: vs[vs.length - 1] ?? "" }))}
              />
            </Section>
          ) : null}
          {sections.map((s) => {
            const p = draft.cf[s.k];
            if (s.kind === "list") {
              const picked = p && "in" in p ? p.in : [];
              return (
                <Section key={s.k} title={s.l} aside={picked.length ? `${nf(picked.length)} picked` : "Any"}>
                  <ListPicker
                    opts={s.opts.map((o) => ({ v: o.v, l: blankWord(o.v), n: o.n }))}
                    picked={picked}
                    more={s.more}
                    search={`Search ${s.l.toLowerCase()}`}
                    onChange={(vs) => setPick(s.k, { in: vs })}
                  />
                </Section>
              );
            }
            const r = p && "min" in p ? p : { min: "", max: "" };
            const fmt = (v: number | null) => (v == null ? "" : s.money ? moneyText(s, v) : `${nf(v)}${s.u ? ` ${s.u}` : ""}`);
            const clean = (v: string) => cleanDecimal(v.replace(/[^\d.]/g, ""), s.money ? 2 : 3);
            return (
              <Section key={s.k} title={`${s.l}${s.money ? " (₹)" : s.u ? ` (${s.u})` : ""}`} aside={s.lo != null && s.hi != null ? `${fmt(s.lo)} – ${fmt(s.hi)}` : undefined}>
                <div className="flex items-center gap-2">
                  <Input aria-label={`${s.l} from`} placeholder="From" inputMode="decimal" value={r.min} onChange={(e) => setPick(s.k, { ...r, min: clean(e.target.value) })} />
                  <span className="text-muted">–</span>
                  <Input aria-label={`${s.l} to`} placeholder="To" inputMode="decimal" value={r.max} onChange={(e) => setPick(s.k, { ...r, max: clean(e.target.value) })} />
                </div>
              </Section>
            );
          })}
        </div>
        <div className="flex items-center gap-2 rounded-b-card border-t border-line bg-canvas px-4.5 py-3">
          <span className="text-xs text-muted">{changed ? "Not applied yet" : "No changes"}</span>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onApply(next, draft.gf)}>
            {shown ? `Apply · ${nf(shown.n)}` : "Apply"}
          </Button>
        </div>
      </div>
    </>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-divider px-4.5 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-ink">{title}</span>
        {aside ? <span className="truncate text-xs text-muted tabular-nums">{aside}</span> : null}
      </div>
      {children}
    </div>
  );
}

type Opt = { v: string; l: string; n?: number; sub?: string };

/** A handful of values as pills; more as a search over a tick list. `one` picks a single value. */
function ListPicker({ opts, picked, more = 0, one, search, onChange }: { opts: Opt[]; picked: string[]; more?: number; one?: boolean; search: string; onChange: (vs: string[]) => void }) {
  const [q, setQ] = useState("");
  const toggle = (v: string) => {
    if (one) return onChange(picked.includes(v) ? [] : [v]);
    onChange(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]);
  };
  if (opts.length <= PILL_MAX && !more) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {opts.map((o) => {
          const on = picked.includes(o.v);
          return (
            <button
              key={o.v}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(o.v)}
              className={cx(
                "inline-flex h-7.5 cursor-pointer items-center gap-1.5 rounded-control border px-2.5 text-meta font-medium",
                on ? "border-brand bg-brand-soft text-brand-hover" : "border-line bg-surface text-body hover:border-line-strong",
                !on && o.n === 0 && "opacity-50",
              )}
            >
              {o.l}
              {o.n != null ? <span className={cx("tabular-nums", on ? "text-brand" : "text-muted")}>{nf(o.n)}</span> : null}
            </button>
          );
        })}
      </div>
    );
  }
  const ql = q.trim().toLowerCase();
  /* What is ticked stays at the top, so a tick never scrolls out of sight. */
  const matched = opts.filter((o) => !ql || `${o.l} ${o.sub ?? ""}`.toLowerCase().includes(ql));
  const ordered = [...matched.filter((o) => picked.includes(o.v)), ...matched.filter((o) => !picked.includes(o.v))];
  const list = ordered.slice(0, LIST_SHOWN);
  const hidden = ordered.length - list.length + (ql ? 0 : more);
  return (
    <>
      <Input aria-label={search} placeholder={search} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="flex max-h-[180px] flex-col overflow-y-auto rounded-control border border-divider">
        {list.length ? (
          list.map((o) => (
            <label key={o.v} className="flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-meta text-body hover:bg-canvas">
              <input type={one ? "radio" : "checkbox"} className={checkboxClass} checked={picked.includes(o.v)} onChange={() => toggle(o.v)} />
              <span className="min-w-0 flex-1 truncate">
                {o.l}
                {o.sub ? <span className="text-muted"> · {o.sub}</span> : null}
              </span>
              {o.n != null ? <span className="text-xs text-muted tabular-nums">{nf(o.n)}</span> : null}
            </label>
          ))
        ) : (
          <span className="px-2.5 py-2 text-meta text-muted">Nothing matches “{q}”.</span>
        )}
      </div>
      {hidden > 0 ? <span className="text-xs text-muted">{nf(hidden)} more — search to find them</span> : null}
    </>
  );
}
