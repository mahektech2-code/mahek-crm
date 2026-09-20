"use client";

import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { LEAD_TILES, type LeadTileId, type LeadView } from "@/lib/lead-views";

/* ---------------------------------------------------------------------------
 * §8.2 — THE NINE, DRAWN ABOVE THE LIST THEY CUT.
 *
 * Every tile is a DOOR and every figure is counted over the SAME filters the
 * table is showing. Those two rules are what make a summary strip worth
 * drawing at all, and both are easy to lose: a strip whose figures come from
 * their own queries drifts from the screens it opens, and a strip that keeps
 * saying "412 leads" over a table filtered to eleven is one people learn to
 * stop reading. `lead-views-service.ts` holds both halves — the counts come
 * from the clause the table ran, and each tile's destination is that clause
 * plus its own parameters.
 *
 * IT IS THE SAME STRIP THE DASHBOARD DRAWS, AND IT IS NOT THE SAME NINE. The
 * manager dashboard one tab along draws §8.2's seven management BLOCKS, which
 * are queues waiting on a decision; these are §8.4's nine cuts of the book,
 * which are populations. Two tiles overlap in spirit and neither is derived
 * from the other, because they are counted over different things — the
 * dashboard's over the whole scoped book, these over whatever is filtered
 * here. If the two are ever to share, the thing to share is the tile SKIN and
 * not the figures; see the note under `SKIN`.
 *
 * A CLIENT COMPONENT because the hrefs are built off the URL the reader is
 * standing on: a tile has to ADD its parameters to the filters already set
 * rather than replace them, or pressing one throws away the search somebody
 * typed. It reads the current parameters as a prop rather than through
 * `useSearchParams` so the screen has exactly one reading of them.
 * ------------------------------------------------------------------------- */

/**
 * The tile's skin per tone. Number colour and border only — no new card style.
 *
 * DELIBERATELY A COPY OF THE DASHBOARD'S, and the duplication is four lines of
 * class names rather than a rule. What must not be copied is the JUDGEMENT of
 * which tone a figure earns, and that is not here: it is declared beside each
 * tile in `lead-views.ts`, with the reasoning, exactly as the dashboard's is
 * declared beside each block in its service. A shared component would couple
 * this screen to a file another part of the console owns for the sake of a
 * border colour.
 */
const SKIN: Record<(typeof LEAD_TILES)[number]["tone"], { border: string; value: string }> = {
  danger: { border: "border-danger-soft", value: "text-danger" },
  warn: { border: "border-warn-line", value: "text-warn-ink" },
  brand: { border: "border-line", value: "text-ink" },
  muted: { border: "border-line", value: "text-muted" },
};

export function TileStrip({
  counts,
  view,
  hrefFor,
}: {
  /** One per tile, counted in SQL over the filtered set. */
  counts: Record<LeadTileId, number>;
  /** Which view the reader is standing in, so its own tile can say so. */
  view: LeadView;
  /**
   * The tile's destination, built by the screen from the URL it is on plus the
   * tile's own parameters. Passed in rather than assembled here because the
   * screen already owns one function that writes a filter to the URL, and two
   * would eventually disagree about which parameters survive a click.
   */
  hrefFor: (params: Record<string, string>) => string;
}) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
      {LEAD_TILES.map((tile) => {
        const count = counts[tile.id] ?? 0;
        /*
         * A ZERO IS DRAWN QUIET, and that is the absence of a second opinion
         * rather than one. Three of these carry a fixed tone, so an empty
         * queue would otherwise print a confident coloured 0 beside eight live
         * ones and read as a figure worth looking at.
         */
        const empty = count === 0;
        const skin = SKIN[empty ? "muted" : tile.tone];
        /* The tile you are standing in is marked rather than un-linked:
           pressing it again is a harmless way back to the same list, and a
           tile that stops being a link is one people read as broken. */
        const here = tile.params.view === view;
        return (
          <Link
            key={tile.id}
            href={hrefFor(tile.params)}
            aria-current={here ? "page" : undefined}
            title={empty ? `${tile.label} — nothing here under these filters.` : tile.hint}
            className={cx(
              "block rounded-[6px] border bg-surface px-3 py-2.5 no-underline",
              "hover:border-line-strong hover:no-underline",
              here ? "border-b-2 border-b-brand" : skin.border,
            )}
          >
            <span className="block text-[10px] leading-[14px] font-medium tracking-[0.04em] text-muted uppercase">
              {tile.label}
            </span>
            <span
              className={cx(
                "mt-0.5 block text-[20px] leading-6 font-semibold tabular-nums",
                skin.value,
              )}
            >
              {count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
