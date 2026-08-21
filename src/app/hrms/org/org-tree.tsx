"use client";

import * as React from "react";
import type { OrgPerson } from "@/lib/services/org-service";
import { cx } from "@/components/ui/primitives";

/* ---------------------------------------------------------------------------
 * The chart people actually picture when they say "org chart": cards, drawn
 * top-down, joined by lines.
 *
 * THE LINES ARE REAL ELEMENTS, not pseudo-elements or a drawing library. Three
 * spans per child — a horizontal segment, a vertical stem, and nothing else —
 * which means the whole thing is server-rendered HTML that prints, scales with
 * the font, and has no runtime measuring the DOM to place a connector. A chart
 * that needs JavaScript to draw its own lines is a chart that is blank for a
 * moment on every load and wrong on every zoom.
 *
 * The first child's segment starts at its own centre and the last one's ends
 * there, so the horizontal rail spans exactly from the first card to the last
 * rather than hanging past both ends. A single child gets no rail at all — just
 * the stem — because a one-inch horizontal line joining nothing reads as a
 * missing sibling.
 *
 * IT SCROLLS SIDEWAYS AND THAT IS THE POINT. A wide layer is wide; the honest
 * answer is a scroll container rather than shrinking cards until names truncate.
 * The indented list is still there for reading the whole company at once, which
 * is the thing this view is bad at.
 * ------------------------------------------------------------------------- */

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** Stable per person, so a face keeps its colour between visits. */
const TONES = [
  "bg-[#EEF0FF] text-[#4338CA]",
  "bg-[#E8F5EE] text-[#166534]",
  "bg-[#FFF1E6] text-[#9A3412]",
  "bg-[#FDE8EF] text-[#9D174D]",
  "bg-[#E6F4FA] text-[#155E75]",
  "bg-[#F3E8FF] text-[#6B21A8]",
];
const toneFor = (id: string) => {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return TONES[n % TONES.length];
};

export function OrgTree({
  roots,
  company,
  onEdit,
  busy,
}: {
  roots: OrgPerson[];
  /** The organisation everybody belongs to. Drawn as the single head. */
  company: string;
  onEdit: (p: OrgPerson) => void;
  busy: boolean;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);

  /*
   * OPEN ON THE MIDDLE, not on the left edge.
   *
   * A tree is drawn with each parent centred over its children, so a wide layer
   * pushes the top of the company towards the middle of a canvas far wider than
   * the screen. Left-aligned, the page opens on a corner of the org — the first
   * thing visible is a row of helpers and the person at the top is off-screen,
   * which reads as the chart being broken.
   *
   * An effect, because this is a measurement: the scroll width is not knowable
   * until the browser has laid the cards out. It runs once on mount and after
   * any change to the shape, never on every render.
   */
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [roots]);

  return (
    // The scroll lives here, on its own container, so the page body never
    // scrolls sideways however wide a layer gets.
    <div ref={scroller} className="overflow-x-auto px-5 py-6">
      {/*
        THE COMPANY IS THE HEAD OF THE TREE.
        
        Without it, several people with nobody above them are several loose
        trees standing side by side, and the chart has no top — which reads as
        unfinished rather than as "these four report to nobody". One node above
        them says the true thing: they all belong to the same organisation, and
        each is a top of their own part of it.

        It is NOT a person. No avatar, no count, and nothing to click, because
        there is nothing about it to change from here — the name is a setting,
        and a node that looks clickable and is not is worse than a plain label.
      */}
      <div className="inline-flex min-w-full flex-col items-center">
        <span className="flex items-center gap-2 rounded-[8px] border border-line bg-canvas px-3.5 py-2">
          <span
            aria-hidden
            className="flex size-5 flex-none items-center justify-center rounded-[4px] bg-brand text-[11px] font-bold text-white"
          >
            M
          </span>
          <span className="text-[13px] font-semibold text-ink">{company}</span>
        </span>

        {roots.length ? (
          <>
            <span aria-hidden className="h-5 w-px flex-none bg-line-strong" />
            <div className="flex items-start">
              {roots.map((person, i) => (
                <div key={person.id} className="relative flex flex-col items-center px-3 pt-5">
                  {roots.length > 1 ? (
                    <span
                      aria-hidden
                      className={cx(
                        "absolute top-0 h-px bg-line-strong",
                        i === 0
                          ? "left-1/2 right-0"
                          : i === roots.length - 1
                            ? "left-0 right-1/2"
                            : "left-0 right-0",
                      )}
                    />
                  ) : null}
                  <span
                    aria-hidden
                    className="absolute top-0 left-1/2 h-5 w-px -translate-x-1/2 bg-line-strong"
                  />
                  <Node person={person} onEdit={onEdit} busy={busy} />
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Node({
  person,
  onEdit,
  busy,
}: {
  person: OrgPerson;
  onEdit: (p: OrgPerson) => void;
  busy: boolean;
}) {
  const kids = person.reports;

  return (
    <div className="flex flex-col items-center">
      <Card person={person} onEdit={onEdit} busy={busy} />

      {kids.length ? (
        <>
          {/* The stem down out of this card. */}
          <span aria-hidden className="h-5 w-px flex-none bg-line-strong" />

          <div className="flex items-start">
            {kids.map((child, i) => (
              <div key={child.id} className="relative flex flex-col items-center px-3 pt-5">
                {/*
                  The rail. Half-width on the ends so it stops at the first and
                  last card's centre instead of overhanging into empty space.
                */}
                {kids.length > 1 ? (
                  <span
                    aria-hidden
                    className={cx(
                      "absolute top-0 h-px bg-line-strong",
                      i === 0
                        ? "left-1/2 right-0"
                        : i === kids.length - 1
                          ? "left-0 right-1/2"
                          : "left-0 right-0",
                    )}
                  />
                ) : null}
                {/* The stem up into this child. */}
                <span
                  aria-hidden
                  className="absolute top-0 left-1/2 h-5 w-px -translate-x-1/2 bg-line-strong"
                />
                <Node person={child} onEdit={onEdit} busy={busy} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Card({
  person,
  onEdit,
  busy,
}: {
  person: OrgPerson;
  onEdit: (p: OrgPerson) => void;
  busy: boolean;
}) {
  const left = person.status === "inactive";

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onEdit(person)}
      title={`Change who ${person.name} reports to`}
      className={cx(
        // A fixed width, because ragged cards make the rails meet them at
        // different points and the whole chart looks bent.
        "flex w-[252px] flex-none cursor-pointer items-center gap-2.5 rounded-[8px] border bg-surface px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(16,24,40,0.06)] transition-shadow hover:shadow-[0_4px_12px_rgba(16,24,40,0.12)] disabled:cursor-not-allowed",
        left ? "border-dashed border-line" : "border-line",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "flex size-9 flex-none items-center justify-center rounded-full text-[13px] font-semibold",
          toneFor(person.id),
        )}
      >
        {initials(person.name)}
      </span>

      <span className="min-w-0 flex-1">
        {/*
          The NAME wraps; the position truncates. Full Indian names run long —
          "Sarthika Sandesh Lon…" tells you nothing about who that is, and this
          is a chart people read to find a person. The role underneath can lose
          its tail without costing anybody the answer.
        */}
        <span className="block text-[13px] leading-[17px] font-semibold text-balance text-ink">
          {person.name}
        </span>
        <span
          className="mt-px block truncate text-[12px] text-muted italic"
          title={person.position ?? undefined}
        >
          {person.position ?? "No position recorded"}
        </span>
      </span>

      {person.reports.length ? (
        <span
          className="flex-none rounded-full bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-muted tabular-nums"
          title={`${person.reports.length} direct ${person.reports.length === 1 ? "report" : "reports"}`}
        >
          {person.reports.length}
        </span>
      ) : null}
    </button>
  );
}
