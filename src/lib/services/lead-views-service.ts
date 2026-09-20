import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { dueTodayWindow, overdueWindow, STILL_WORKING } from "../lead-action-window";
import { confirmedCommitmentSql } from "../lead-commitment";
import type { LeadFilters } from "../lead-filters";
import { LEAD_TILES, type LeadTileId, type LeadView } from "../lead-views";
import type { VantageSeats } from "../lead-vantage";
import { leadFilterClause, leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * §8.4 — A VIEW, IN SQL, AND THE NINE TILES ABOVE IT.
 *
 * `lib/lead-views.ts` is the vocabulary and this is the half that reads the
 * book. The rule the whole file is arranged around is that a tile's NUMBER and
 * the LIST it opens come from the same clause: `leadViewClause` is read by the
 * strip's count AND by the page of rows behind it, so the two cannot disagree
 * about one lead. Two definitions of "overdue" would look right on both
 * screens separately and only be caught by somebody comparing them, which
 * nobody does.
 *
 * NOTHING HERE IS A SECOND OPINION ABOUT AN EXISTING SCREEN. Today and Overdue
 * take the windows `lead-actions-service.ts` reads, extracted rather than
 * copied. Expected takes `confirmedCommitmentSql`, the one place §3.4's "a day
 * AND a size" is written. Register and Lost are the only two predicates
 * written here, and both are one stored column.
 *
 * SCOPED LIKE EVERY OTHER LIST. `managerScope` and `leadsVisible` are the same
 * narrowing the table itself runs through, and a view can only remove rows
 * from what that already allows — see the note in `lead-views.ts`: a view is
 * not a permission.
 *
 * IN RAW SQL, QUALIFY EVERY COLUMN OF THE OUTER TABLE. Drizzle renders a bare
 * `"id"` for `${customers.id}`, which inside a correlated subquery binds to
 * the INNER table and silently makes the condition false — types and unit
 * tests both pass. Every reference below is spelled `c.` for that reason.
 * ------------------------------------------------------------------------- */

/**
 * THE THREE SEATS "MY LEADS" MEANS, AND WHY IT IS THE SEATS RATHER THAN §7.
 *
 * `vantagesFor` answers which of five jobs somebody is doing on a lead, from
 * two halves: the SEATS on the row, and the HATS on the person. The hats half
 * is true of the whole book at once — a sales manager holds the sales_manager
 * vantage on all four hundred leads, and management holds one on every one of
 * them — so a view built on the engine's own answer would be the entire list
 * for exactly the people who most need it narrowed. What a person means by
 * "my leads" is the rows with their name on them, which is the seats.
 *
 * So this is the SEATS half of `vantagesFor` and deliberately not a second
 * opinion about it. Whether a seat is asking for something TODAY is
 * `isOnQueueFor`, which is per vantage and per rung and cannot be said in SQL
 * — the For you column and the line above the table are where that answer
 * lives, counted over the page, and `leads-screen.tsx` carries the paragraph
 * saying why it can only be counted there.
 *
 * KEYED ON `VantageSeats` so the two cannot drift: a fourth seat added to that
 * type fails this build rather than quietly falling out of the view. That is
 * the same discipline `handover.test.ts` applies to the seat labels — a new
 * seat should fail at the schema, not on a screen.
 */
const SEAT_COLUMNS: Record<keyof VantageSeats, string> = {
  ownerId: "c.owner_id",
  backOfficeAmId: "c.back_office_am_id",
  leadManagerId: "c.lead_manager_id",
};

/** `lost30`'s window, in days. A month, said as thirty. */
const LOST_WINDOW_DAYS = 30;

/**
 * ONE VIEW, AS A BOOLEAN EXPRESSION.
 *
 * Bare rather than `and …`-prefixed, because it is spliced into two shapes: a
 * `count(*) filter (where …)` in the strip and an `and (…)` in the page query.
 * A fragment that carried its own conjunction could only be used in one of
 * them, which is how a view comes to have two spellings.
 *
 * `all` and `archived` answer TRUE. Neither is a narrowing of the rows — the
 * first is the absence of one and the second is already the `lead_archived`
 * flag the base query carries, because archived leads are a different book
 * rather than a cut of this one and every count around the table has to be
 * taken inside it.
 *
 * The signed-in person is resolved HERE rather than taken as a parameter, so
 * no call site can pass somebody else's id into "my leads". The import is
 * dynamic for the reason `lead-console-service.ts` does the same: a service
 * that imports the auth module at the top pulls request-scoped machinery into
 * every job and script that reads a lead.
 */
export async function leadViewClause(view: LeadView, day: string): Promise<SQL> {
  switch (view) {
    case "all":
    case "archived":
      return sql`true`;

    case "mine": {
      const { requireUser } = await import("../auth");
      const me = (await requireUser()).id;
      return sql`(${sql.join(
        Object.values(SEAT_COLUMNS).map((col) => sql`${sql.raw(col)} = ${me}`),
        sql` or `,
      )})`;
    }

    case "today":
      return sql`(${STILL_WORKING}) and ${dueTodayWindow(day)}`;

    case "overdue":
      return sql`(${STILL_WORKING}) and ${overdueWindow(day)}`;

    /* §3.4 — a day AND a size, from the one file that decides it. A date alone
       is a follow-up somebody has to make and is deliberately not counted, so
       this tile can never put money on a screen that nobody ever asked the
       size of. */
    case "expected":
      return sql`(${STILL_WORKING}) and ${sql.raw(confirmedCommitmentSql("c"))}`;

    /*
     * REACHED Lost inside the window, dated from `lead_stage_since`.
     *
     * That column is the day the lead arrived at the rung it is on, which for
     * a lost lead is the day it was closed — its own column rather than the
     * newest transition row precisely so a list can age by it without a
     * correlated subquery per row. A lead with no `lead_stage_since` falls
     * out, and that is the honest answer rather than a miss: it is a legacy
     * row whose closing day nobody recorded, and counting it as "lost this
     * month" would put a date on it that nothing supports.
     */
    case "lost30":
      return sql`c.lead_stage = 'lost'
                 and c.lead_stage_since is not null
                 and c.lead_stage_since >= ${day}::date - ${LOST_WINDOW_DAYS}`;

    /*
     * THE REGISTER IS BOTH HALVES OF ONE CHAIN, which is why it is one view.
     *
     * A distributor buys from us and sells the goods on; a third-party shop is
     * where the drums actually go and somebody else holds the invoice. Read
     * apart, each list leaves nobody to ask about the other — AGENTS.md makes
     * the same argument about `customer_distributors` being a list rather than
     * a column. The distributor ladder is RETIRED and the screen says so in
     * words (`retiredLadderNote`); the leads already on it are still here,
     * because withdrawing a ladder was never a decision to hide the leads
     * parked on it.
     */
    case "register":
      return sql`c.lead_sales_type::text in ('distributor', 'third_party')`;
  }
}

/**
 * THE NINE, COUNTED LIVE AGAINST WHATEVER IS FILTERED.
 *
 * ONE STATEMENT, nine conditional counts, for the reason the manager
 * dashboard's own strip is one: nine round trips to answer one strip is nine
 * chances for the figures to disagree with each other, because the book moves
 * while they are being asked. Read together they are a consistent picture of
 * one instant.
 *
 * COUNTED OVER THE FILTERS AND NOT OVER THE CURRENT VIEW, which is the one
 * decision in this function worth stating. A strip counted inside the view you
 * are standing in would answer "how many of these eleven overdue leads are in
 * negotiation" — a real question, and not the one a strip of doors is for.
 * Every tile stays a count of what it would open FROM HERE, with the search
 * and the eight dropdowns applied, so pressing one narrows and never surprises.
 *
 * Five of the nine ask `leadFilterClause` itself, with their own `stage`
 * overlaid on what is already ticked, so the count is produced by the very
 * function the table ran. The other four ask `leadViewClause`, which is what
 * the page of rows behind them will ask too.
 */
export async function leadTileCounts(
  day: string,
  options: { archived?: boolean; filters?: LeadFilters } = {},
): Promise<Record<LeadTileId, number>> {
  const scope = await managerScope();
  const { getConfig } = await import("../config/store");
  const config = await getConfig();
  const archived = options.archived ?? false;
  const filters = options.filters ?? {};
  const health = {
    atRiskBelow: config["mbos.health.atRiskBelow"],
    strongAtOrAbove: config["mbos.health.strongAtOrAbove"],
  };

  /*
   * ONE TILE'S PREDICATE, and only the part that is the TILE'S OWN.
   *
   * The search and the other seven dropdowns are applied once, in the `where`
   * below, so what varies between the nine counts is exactly what varies
   * between the nine destinations. A stage tile asks `leadFilterClause` for
   * nothing but its own `stage`, which is the same function and the same
   * spelling the table ran; that clause returns fragments each beginning with
   * `and`, so it is spelled against `true` — which reads oddly for a moment
   * and is what lets this be the literal clause rather than a re-derivation
   * of it.
   */
  const predicate = async (id: LeadTileId): Promise<SQL> => {
    const tile = LEAD_TILES.find((t) => t.id === id)!;
    if (tile.params.view) {
      return leadViewClause(tile.params.view as LeadView, day);
    }
    return sql`true ${leadFilterClause({ stage: tile.params.stage }, day, health)}`;
  };

  const ids = LEAD_TILES.map((t) => t.id);
  const predicates = await Promise.all(ids.map(predicate));

  /* The base is the same `where` the table runs, minus the view. The filters
     are applied ONCE, outside the conditional counts, so a stage tile's own
     overlay is the only thing that differs between the nine. */
  const [row] = await db.execute<Record<LeadTileId, number>>(sql`
    select ${sql.join(
      ids.map(
        (id, i) => sql`count(*) filter (where ${predicates[i]})::int as ${sql.raw(`"${id}"`)}`,
      ),
      sql`, `,
    )}
      from customers c
     where c.lead_stage is not null
       and c.lead_archived = ${archived}
       ${leadsVisible(scope)}
       ${leadFilterClause(filters, day, health)}
  `);

  return Object.fromEntries(
    ids.map((id) => [id, Number(row?.[id] ?? 0)]),
  ) as Record<LeadTileId, number>;
}
