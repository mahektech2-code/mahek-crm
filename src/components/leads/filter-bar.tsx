"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { MultiSelect } from "@/components/ui/multi-select";
import { PlacePicker } from "@/components/leads/place-picker";
import {
  AGE_BUCKETS,
  HEALTH_BUCKETS,
  NEXT_BUCKETS,
  POTENTIAL_BUCKETS,
  PRIORITY_BUCKETS,
  SALES_TYPE_BUCKETS,
  type FilterOption,
} from "@/lib/lead-filters";
import { decodePlace, placeLabel } from "@/lib/lead-places";
import { stageLabel, type LeadStage } from "@/lib/lead-labels";
import type { PlaceTree } from "@/lib/services/sales-service";

/* ---------------------------------------------------------------------------
 * ONE FILTER BAR, FOR THE LIST AND THE BOARD, AND IT IS A BUTTON RATHER THAN
 * A WALL.
 *
 * It was ten dropdowns laid out side by side, wrapping onto three rows on a
 * laptop, each one labelled only by the placeholder inside it — so the screen
 * opened with more filter than table and the first question a person asked was
 * which of the ten boxes was which. Ten controls drawn at once is not ten
 * options offered; it is one option offered ten times over, and the ones nobody
 * can find are the ones nobody uses.
 *
 * So: a search box, ONE button that says how many filters are on, and a chip
 * per filter that is actually on. The panel behind the button is where the ten
 * live, grouped under headings and labelled in words — a label above a control
 * is the cheapest thing on this screen and it was the missing thing.
 *
 * WHAT IS ON IS ON THE BAR, never only inside the panel. A filter somebody
 * cannot see is a filter they forget they set, and then the list is wrong and
 * the screen is lying; every chip carries its own ✕ so undoing one narrowing
 * does not mean opening a panel to find it.
 *
 * ONE COMPONENT BECAUSE THERE WERE TWO. The list and the stage board each had
 * their own copy of this bar — same parameters, same bucket lists, two sets of
 * markup — and they had already drifted: the board's was missing Sales type and
 * Priority, so a filter that existed on one screen simply did not on the other,
 * with nothing anywhere saying so. `columns` is what an app varies now, and the
 * board still leaves out the ladder filter because a ladder is what that screen
 * IS.
 * ------------------------------------------------------------------------- */

/**
 * THE COLUMNS THAT CAN BE NARROWED, in the order they appear in the table — so
 * the panel reads top to bottom exactly like the header reads left to right.
 *
 * Declared once and iterated: the URL parameter, the ticked state, the chips,
 * "Clear all" and "Select everything this filter reaches" all walk this list,
 * which is what stops an eleventh filter being added to the panel and quietly
 * not being cleared by the button that says it clears everything.
 */
export const LEAD_FILTER_COLUMNS = [
  /* WHERE, FIRST, because it is the one narrowing that is about the work
     rather than about the record: a manager planning a week is choosing a
     town before they choose anything else about a lead. */
  "place",
  "owner",
  "source",
  "potential",
  "priority",
  "salesType",
  "stage",
  "next",
  "age",
  "health",
] as const;

export type LeadFilterColumn = (typeof LEAD_FILTER_COLUMNS)[number];

/** Clear of the window's own edges. */
const MARGIN = 8;
/** Below this there is no room worth opening downwards into. */
const MIN_PANEL = 360;
const PANEL_MAX = 620;

export type LeadFilterOptions = {
  owners: Array<FilterOption & { count: number }>;
  sources: Array<FilterOption & { count: number }>;
  stages: Array<FilterOption & { count: number }>;
};

/** What each column is called on the panel, on a chip, and in a tooltip. */
const COLUMN_TEXT: Record<
  LeadFilterColumn,
  { label: string; placeholder: string; hint?: string }
> = {
  place: {
    label: "Where",
    placeholder: "Everywhere",
    hint: "State, then city, then area. It reads the same expressions a salesman's territory does, so this list and his handset cannot disagree about which shops a place has.",
  },
  owner: {
    label: "Owner",
    placeholder: "All owners",
    hint: "Who is working the lead. Nobody is a real answer and is offered as one.",
  },
  source: { label: "Source", placeholder: "All sources" },
  potential: {
    label: "Potential",
    placeholder: "Any potential",
    hint: "Somebody's estimate of what the shop could spend in a month. Not estimated is not the same as nothing.",
  },
  priority: {
    label: "Priority",
    placeholder: "Any priority",
    hint: "How hard a manager has asked for this one to be pushed — not what it is worth. Not set is the one most of the book sits on, and it is a real answer rather than a gap.",
  },
  salesType: {
    label: "Ladder",
    placeholder: "All ladders",
    hint: "Which of the three ladders this lead climbs, and the fourth answer that is not one. A RUNG is not a track — Suspect is the foot of all three — so narrowing by stage alone answers with every ladder at once.",
  },
  stage: { label: "Stage", placeholder: "All stages" },
  next: {
    label: "Next step",
    placeholder: "Any next step",
    hint: "The follow-up somebody promised. None promised is the one worth looking at.",
  },
  age: { label: "Age", placeholder: "Any age" },
  health: {
    label: "Health",
    placeholder: "Any health",
    hint: "What the health column says. A lead that has never ordered is in no band at all — that is an option rather than a gap.",
  },
};

/** The panel's headings, so ten controls read as four questions. */
const GROUPS: Array<{ title: string; columns: LeadFilterColumn[] }> = [
  { title: "Where it is", columns: ["place"] },
  { title: "Who has it", columns: ["owner", "source"] },
  { title: "What it is worth", columns: ["potential", "priority"] },
  { title: "How far it has got", columns: ["salesType", "stage"] },
  { title: "When and how it is doing", columns: ["next", "age", "health"] },
];

const BUCKETS: Partial<Record<LeadFilterColumn, readonly FilterOption[]>> = {
  potential: POTENTIAL_BUCKETS,
  priority: PRIORITY_BUCKETS,
  salesType: SALES_TYPE_BUCKETS,
  next: NEXT_BUCKETS,
  age: AGE_BUCKETS,
  health: HEALTH_BUCKETS,
};

export function LeadFilterBar({
  columns,
  filters,
  options,
  places,
  navigate,
  onClear,
  total,
  listTotal,
  totalSuffix = "",
  search,
  onSearch,
  className,
}: {
  /** Which of the ten this screen draws. See `LEAD_FILTER_COLUMNS`. */
  columns: readonly LeadFilterColumn[];
  filters: Record<LeadFilterColumn, string[]>;
  options: LeadFilterOptions;
  /** State → city → area, counted over the same list. Read by the Where picker. */
  places: PlaceTree;
  navigate: (patch: Record<string, string | number | undefined>) => void;
  onClear: () => void;
  total: number;
  listTotal: number;
  /** " on this ladder", where the screen is one. */
  totalSuffix?: string;
  /** Absent means the screen draws no search box — see the board. */
  search?: string;
  onSearch?: (v: string) => void;
  className?: string;
}) {
  const [at, setAt] = React.useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const open = at !== null;

  const close = React.useCallback(() => setAt(null), []);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      /* A MultiSelect inside the panel portals its own list into the body, so
         a click on one of ITS options lands outside this panel's subtree. Shut
         on that and every tick inside the panel would close the panel under
         the finger that made it. */
      if ((target as Element).closest?.("[role='listbox']")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    /* Capture, because the scroll that matters is the page's and a scroll on
       an inner element does not bubble — but a captured listener also sees the
       panel's OWN lists scrolling, which is not a reason to shut. The panel is
       positioned from a rectangle measured at open time, so a page that
       scrolls under it leaves it pointing at nothing. */
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  /**
   * ANCHORED TO THE TRIGGER AND CAPPED BY THE WINDOW, which is what a fixed
   * panel has to be told: it was capped at a flat 620px, so on a laptop the
   * footer — the one carrying "Clear all" and "Done" — sat below the fold with
   * nothing to scroll, and the only way out of the panel was the Escape key.
   *
   * Below the button where there is room, above it where there is more room
   * up there, which is the same escape `MultiSelect` makes one control down.
   */
  function place() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 560;
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
    const below = window.innerHeight - rect.bottom - MARGIN - 4;
    const above = rect.top - MARGIN - 4;

    if (below >= MIN_PANEL || below >= above) {
      setAt({ top: rect.bottom + 4, left, maxHeight: Math.min(PANEL_MAX, below) });
      return;
    }
    const height = Math.min(PANEL_MAX, above);
    setAt({ top: rect.top - height - 4, left, maxHeight: height });
  }

  const drawn = LEAD_FILTER_COLUMNS.filter((c) => columns.includes(c));
  const on = drawn.filter((c) => filters[c].length > 0);
  const onCount = on.reduce((n, c) => n + filters[c].length, 0);
  const anyFilter = onCount > 0 || Boolean(search?.trim());

  /** Every active narrowing, as one flat list of removable chips. */
  const chips = on.flatMap((column) =>
    filters[column].map((value) => ({
      column,
      value,
      label: valueLabel(column, value, options),
    })),
  );

  const drop = (column: LeadFilterColumn, value: string) =>
    navigate({
      [column]: filters[column].filter((v) => v !== value).join(",") || undefined,
    });

  const pick = (column: LeadFilterColumn) => (next: string[]) =>
    navigate({ [column]: next.join(",") || undefined });

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        {onSearch ? <SearchBox value={search ?? ""} onChange={onSearch} /> : null}

        <button
          ref={triggerRef}
          type="button"
          onClick={() => (open ? close() : place())}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="Every way this list can be narrowed"
          className={
            "flex h-8.5 cursor-pointer items-center gap-1.5 rounded-[4px] border px-2.5 text-[13px] " +
            (onCount
              ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
              : open
                ? "border-brand bg-surface text-body"
                : "border-line bg-surface text-body hover:bg-canvas")
          }
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="flex-none"
          >
            <path d="M3 4h18l-7 8v6l-4 2v-8z" />
          </svg>
          <span>Filters</span>
          {onCount ? (
            <span className="flex size-[18px] items-center justify-center rounded-full bg-[#5223E0] text-[11px] font-medium text-white">
              {onCount}
            </span>
          ) : null}
        </button>

        {/* WHAT IS ON, ON THE BAR. A narrowing hidden inside a panel is one
            somebody forgets they set, and then the table is right and the
            screen is lying. */}
        {chips.map((c) => (
          <span
            key={`${c.column}:${c.value}`}
            className="inline-flex h-8.5 max-w-[260px] items-center gap-1 rounded-[4px] border border-line bg-canvas pl-2.5 text-[13px] text-body"
          >
            <span className="shrink-0 text-muted">{COLUMN_TEXT[c.column].label}</span>
            <span className="truncate font-medium text-ink">{c.label}</span>
            <button
              type="button"
              onClick={() => drop(c.column, c.value)}
              aria-label={`Remove ${COLUMN_TEXT[c.column].label} ${c.label}`}
              title="Remove this one"
              className="flex h-full cursor-pointer items-center px-2 text-muted hover:text-danger"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </span>
        ))}

        {anyFilter ? (
          <button
            type="button"
            onClick={onClear}
            className="h-8.5 cursor-pointer rounded-[4px] px-2 text-[13px] text-muted underline hover:text-ink"
          >
            Clear all
          </button>
        ) : null}

        <span className="min-w-2 flex-1" />
        {/* What the filters found, against what there is. A count that only
            ever showed the page would say "15" on every screen in the app. */}
        <span className="text-[13px] text-muted">
          {anyFilter
            ? `${total.toLocaleString("en-IN")} of ${listTotal.toLocaleString("en-IN")}${totalSuffix}`
            : `${listTotal.toLocaleString("en-IN")} ${listTotal === 1 ? "lead" : "leads"}${totalSuffix}`}
        </span>
      </div>

      {at
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Narrow this list"
              style={{ top: at.top, left: at.left, width: 560, maxHeight: at.maxHeight }}
              className="animate-fade-in fixed z-50 flex flex-col overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
            >
              <div className="flex-1 overflow-y-auto px-4 py-3">
                {GROUPS.map((group) => {
                  const inGroup = group.columns.filter((c) => columns.includes(c));
                  if (!inGroup.length) return null;
                  return (
                    <section key={group.title} className="mb-4 last:mb-0">
                      <h3 className="mb-2 border-b border-line pb-1 text-[12px] font-medium tracking-wide text-muted uppercase">
                        {group.title}
                      </h3>
                      {inGroup.map((column) =>
                        column === "place" ? (
                          <div key={column}>
                            <p className="mb-1.5 text-[12px] text-pretty text-muted">
                              {COLUMN_TEXT.place.hint}
                            </p>
                            <PlacePicker
                              tree={places}
                              picked={filters.place}
                              onChange={(next) => pick("place")(next)}
                            />
                          </div>
                        ) : (
                          <div key={column} className="mb-2 flex items-center gap-3 last:mb-0">
                            <label
                              className="w-[92px] shrink-0 text-[13px] text-body"
                              title={COLUMN_TEXT[column].hint}
                            >
                              {COLUMN_TEXT[column].label}
                            </label>
                            <MultiSelect
                              className="min-w-[220px]"
                              label={COLUMN_TEXT[column].label}
                              placeholder={COLUMN_TEXT[column].placeholder}
                              title={COLUMN_TEXT[column].hint}
                              options={optionsFor(column, options)}
                              selected={filters[column]}
                              onChange={pick(column)}
                            />
                          </div>
                        ),
                      )}
                    </section>
                  );
                })}
              </div>

              <footer className="flex flex-none items-center justify-between gap-3 border-t border-line px-4 py-2.5">
                <span className="text-[13px] text-muted">
                  {onCount
                    ? `${total.toLocaleString("en-IN")} of ${listTotal.toLocaleString("en-IN")}${totalSuffix}`
                    : "Nothing narrowed yet"}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={onClear}
                    disabled={!anyFilter}
                    className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body hover:bg-canvas disabled:cursor-not-allowed disabled:text-muted"
                  >
                    Clear all
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    className="h-8 cursor-pointer rounded-[4px] bg-ink px-3 text-[13px] font-medium text-white hover:opacity-90"
                  >
                    Done
                  </button>
                </span>
              </footer>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** The options a column offers — read off the book, or a named bucket list. */
function optionsFor(
  column: LeadFilterColumn,
  options: LeadFilterOptions,
): FilterOption[] {
  /* The count goes on the LABEL rather than the value: "Pritesh Bipin Doshi
     (511)" is what tells a manager which name is worth ticking, and it is the
     one thing a dropdown of twenty names can say that a list of twenty cannot. */
  const withCounts = (rows: Array<FilterOption & { count: number }>) =>
    rows.map((r) => ({ value: r.value, label: `${r.label} (${r.count})` }));

  if (column === "owner") return withCounts(options.owners);
  if (column === "source") return withCounts(options.sources);
  if (column === "stage") return withCounts(options.stages);
  return [...(BUCKETS[column] ?? [])];
}

/**
 * What a chip says for one ticked value.
 *
 * Read off the same lists the panel offers rather than a second table of
 * words, so a chip cannot name a filter differently from the control that set
 * it — and the count is stripped back off an owner's label, because "Priya
 * (511)" on a chip is a number about the unfiltered book sitting on a bar
 * describing a filtered one.
 */
function valueLabel(
  column: LeadFilterColumn,
  value: string,
  options: LeadFilterOptions,
): string {
  if (column === "place") {
    const pick = decodePlace(value);
    return pick ? placeLabel(pick) : value;
  }
  if (column === "owner") return options.owners.find((o) => o.value === value)?.label ?? value;
  if (column === "source")
    return options.sources.find((o) => o.value === value)?.label ?? value.replace(/_/g, " ");
  if (column === "stage")
    return options.stages.find((o) => o.value === value)?.label ?? stageLabel(value as LeadStage);
  return BUCKETS[column]?.find((o) => o.value === value)?.label ?? value;
}

/**
 * The search box.
 *
 * It behaves like the dropdowns beside it — the value lands in the URL, so a
 * search is a thing somebody sends to somebody else and the narrowing happens
 * in the database rather than in a browser holding one page. The DEBOUNCE is
 * the caller's: a dropdown is one click and one navigation, and a search box is
 * one navigation per keystroke unless something upstream stops it.
 *
 * The placeholder names the fields rather than saying "Search", because what
 * it reaches is not guessable: the owner's name is in there, which is the most
 * useful thing to be able to type and the last thing anybody would assume a box
 * above a table of shops would match.
 */
function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search leads"
        placeholder="Search a shop, a town, a phone number, an owner…"
        title="Every word has to appear somewhere: the shop, the company, the phone, the town, the area, the notes or the owner's name."
        className="h-8.5 w-[280px] rounded-[4px] border border-line bg-surface pr-7 pl-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-brand"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear the search"
          className="absolute top-0 right-0 flex h-8.5 w-7 cursor-pointer items-center justify-center text-muted hover:text-ink"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
