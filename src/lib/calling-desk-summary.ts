/* ---------------------------------------------------------------------------
 * The dashboard's arithmetic — the tiles, the lifecycle, the list and the two
 * side cards — as PURE functions over the rows the desk reads.
 *
 * It is here rather than in the service because the dashboard filters IN THE
 * PAGE: pressing a tile must not navigate, so the browser holds every row and
 * asks the same question the server asked. One definition, run in both places,
 * is what keeps "a tile that says 14 opens a list of 14" true after the filter
 * changes without a round trip. The server still runs it for the first paint
 * and for the tests.
 *
 * Client-safe: no database, no clock. `day` is an argument, resolved by the
 * server, because a client may not read the clock while rendering.
 * ------------------------------------------------------------------------- */

import {
  inView,
  type CallOutcome,
  type DeskLeadFacts,
  type DeskPhase,
  type DeskView,
  type LadderKey,
  type NextActionKind,
} from "./engines/lead-calling-desk";
import { daysBetween } from "./calling-desk-labels";
import type { LeadPriority } from "./lead-priority";
import type { LeadSalesType, LeadStage } from "./lead-labels";

/** One lead as the dashboard draws it. Plain data — it crosses to the browser. */
export type DeskLeadRow = {
  id: string;
  name: string;
  city: string | null;
  source: string | null;
  stage: LeadStage;
  salesType: LeadSalesType | null;
  priority: LeadPriority | null;
  createdAt: string;
  nextAction: string | null;
  nextActionDate: string | null;
  nextActionKind: NextActionKind | null;
  /** Who owes the next move, in words — the manager where it is with them. */
  responsible: string | null;
  callCount: number;
  callOutcomes: CallOutcome[];
  phase: DeskPhase;
  /** The call the lead is owed, where one is. */
  nextCall: 1 | 2 | 3 | null;
  answered: number;
  required: number;
  /** The rung it stands on — for a lost lead, the rung it was lost at. */
  ladderKey: LadderKey | null;
  requestedAt: string | null;
  /** No owner yet — on nobody's calling desk. */
  unassigned: boolean;
};

export type LifecycleCell = { key: LadderKey; count: number; waiting: number };

export type DeskSummary = {
  view: DeskView;
  day: string;
  tiles: Record<DeskView, number>;
  lifecycle: LifecycleCell[];
  /** Every lead in the view, in the order V6 sorts them. The caller decides how many to draw. */
  rows: DeskLeadRow[];
  total: number;
  /** "Ready for Prospect" card. */
  ready: DeskLeadRow[];
  /** "Prospect requests with the Sales Manager" card. */
  pending: DeskLeadRow[];
  managerNames: string[];
};

/** How many rows a list draws. The tiles are counted over the whole set. */
export const DESK_LIST_CAP = 300;

/** Every view the strips and lifecycle can open, counted over the same rows. */
export const TILE_VIEWS: DeskView[] = [
  "queue", "all", "new", "today", "followups", "overdue", "call1", "call2", "call3", "ready",
  "suspect", "verify", "requested", "followup", "returned", "handed", "prospect", "qualification",
  "sample_trial", "sample_received", "sample_review", "sample", "negotiation", "orders",
  "first_order", "delivery", "payment", "second_order", "customer", "lost",
];

export const LADDER: LadderKey[] = [
  "suspect", "prospect", "qualification", "sample_trial", "sample_received", "sample_review",
  "negotiation", "first_order", "delivery", "payment", "second_order", "customer",
];

export const factsOf = (r: DeskLeadRow): DeskLeadFacts => ({
  phase: r.phase,
  callCount: r.callCount,
  source: r.source,
  nextActionDate: r.nextActionDate,
  nextActionKind: r.nextActionKind,
  requested: r.requestedAt !== null,
  unassigned: r.unassigned,
});

/** The order V6 sorts a list in: what is ready, then what came back, then soonest due. */
function sortKey(r: DeskLeadRow, day: string): number {
  if (r.phase === "ready") return 0.5;
  if (r.phase === "returned") return 0.4;
  if (!r.nextActionDate) return 999;
  return daysBetween(day, r.nextActionDate);
}

export function deskSummary(all: readonly DeskLeadRow[], view: DeskView, day: string): DeskSummary {
  const tiles = Object.fromEntries(
    TILE_VIEWS.map((v) => [v, all.filter((r) => inView(factsOf(r), v, day)).length]),
  ) as Record<DeskView, number>;

  const lifecycle: LifecycleCell[] = LADDER.map((key) => ({
    key,
    count: all.filter((r) => r.phase !== "lost" && r.ladderKey === key).length,
    /* Requests still with the manager are drawn on the Prospect rung as
       waiting, not counted past it — they are Suspects until it is verified. */
    waiting:
      key === "prospect"
        ? all.filter((r) => r.phase === "requested" || r.phase === "followup").length
        : 0,
  }));

  const rows = all
    .filter((r) => inView(factsOf(r), view, day))
    .sort((a, b) => sortKey(a, day) - sortKey(b, day) || a.id.localeCompare(b.id));

  const managers = new Set(
    all.filter((r) => r.phase === "requested").map((r) => r.responsible).filter(Boolean) as string[],
  );

  return {
    view,
    day,
    tiles,
    lifecycle,
    rows,
    total: rows.length,
    ready: all.filter((r) => r.phase === "ready"),
    pending: all.filter((r) => r.phase === "requested" || r.phase === "followup" || r.phase === "returned"),
    managerNames: [...managers],
  };
}
