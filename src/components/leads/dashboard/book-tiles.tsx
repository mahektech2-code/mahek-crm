"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import type { LeadTileId } from "@/lib/lead-views";
import { TileStrip } from "../tile-strip";

/* ---------------------------------------------------------------------------
 * §8.2's NINE, ON THE DASHBOARD.
 *
 * The nine were drawn on the leads list and nowhere else, so the only summary
 * of the book anybody could see was one they had to open the book to read —
 * and the dashboard, which is the screen somebody actually opens first, showed
 * a salesman his six owed calls and then stopped. `tile-strip.tsx` carries the
 * argument for why these nine and not the dashboard's own seven; the short of
 * it is that the seven are a manager's queues and three of the nine are the
 * reader's own work, so the nine are the strip everybody can read.
 *
 * **IT IS THE SAME COMPONENT, NOT A SECOND DRAWING OF IT.** The tiles, their
 * order, their sentences and — the part that matters — the JUDGEMENT of which
 * tone each one earns all come from `LEAD_TILES`, and the counts come from
 * `leadTileCounts`, which is the same clause the list runs. A second strip
 * typed onto this screen would have been nine labels and nine tones drifting
 * from the nine the list draws, and the half that drifts is always the half
 * somebody is reading.
 *
 * **A CLIENT COMPONENT FOR ONE REASON: `hrefFor` IS A FUNCTION.** The strip
 * takes one because on the list a tile has to ADD its parameters to the
 * filters already on the URL, and a function cannot cross from a server
 * component to a client one. So this is the three lines that build the
 * function, and it builds the simple one — the dashboard stands in no filters,
 * so a tile here is its parameters and nothing else. Nothing in it reads the
 * clock, the URL or anything else a client may not read.
 *
 * `view="all"` is not a claim to be standing in the All view. It is the
 * absence of a view: no tile carries `view=all` in its parameters, so nothing
 * on this strip is marked as the page you are on — which is the true thing,
 * because the page you are on is the dashboard.
 * ------------------------------------------------------------------------- */

export function BookTiles({
  workspace,
  counts,
}: {
  workspace: LeadWorkspace;
  counts: Record<LeadTileId, number>;
}) {
  const hrefFor = (params: Record<string, string>) =>
    leadHref(workspace, `leads?${new URLSearchParams(params).toString()}`);

  return (
    <TileStrip
      counts={counts}
      view="all"
      hrefFor={hrefFor}
      countedOver="in the book you can see"
    />
  );
}
