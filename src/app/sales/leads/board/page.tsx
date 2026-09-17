import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { splitFilter, type LeadFilters } from "@/lib/lead-filters";
import { SALES_TYPES, type LeadSalesType } from "@/lib/lead-labels";
import { leadBoard } from "@/lib/services/lead-board-service";
import { canLead } from "@/lib/services/lead-console-service";
import { leadFilterOptions } from "@/lib/services/sales-service";
import { BoardScreen } from "./board-screen";

export const metadata = { title: "Stage board — Sales Dashboard — MahekOne" };

/**
 * The URL's word for the legacy ladder.
 *
 * `lead_sales_type` is nullable and nothing backfills one, so "no sales type"
 * is a real population with a real ladder — the six rungs this product shipped
 * with. It needs a spelling in a query string, and the spelling is not the
 * empty string: an absent parameter means "the default" and an empty one would
 * be indistinguishable from it on the back button.
 */
const LEGACY = "legacy";

function salesTypeFrom(asked: string | undefined): LeadSalesType | null | undefined {
  if (asked === LEGACY) return null;
  return SALES_TYPES.find((t) => t.code === asked)?.code;
}

/**
 * Screen 3 — the same book as columns per rung.
 *
 * The list answers "which lead", and this answers "where is the book bunching"
 * — the same population, the same filters and the same scope, drawn so that a
 * hundred leads piled on Qualification is a shape somebody sees rather than a
 * number they have to go and compare.
 *
 * **ONE SALES TYPE AT A TIME, and that is not a simplification.** Mahek sells
 * three ways up three different ladders, and drawing them side by side is three
 * boards rather than one: a distributor's `management_review` and a paint
 * shop's `sample_review` are the same distance up two ladders and are not the
 * same work. The control at the top picks the ladder and the columns come from
 * `ladderFor` — no screen here writes a stage list out, which is what stops a
 * twenty-fourth rung being added to the enum and drawn by nobody.
 *
 * **The filters are the list's, read off the URL exactly as `/sales/leads`
 * reads them.** A filtered board is a thing a manager sends somebody — "look at
 * what Rakesh has sitting on Qualification" — and holding that in component
 * state makes the link unsendable and the back button a lie.
 *
 * **The clock is read once, here**, and the gates are evaluated on the server.
 * A client component may not read the clock during render, and the gate engine
 * takes half a customer row as input — see the note in `lead-board-service.ts`
 * on why the VERDICT travels and the input does not.
 *
 * The guard is `board/layout.tsx`, which holds `sales.leads`. Nothing in here
 * re-checks it: one gate per route, in the layout the route sits under.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ type?: string } & Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const user = await requireUser();

  /* Direct is the default because it is the ladder most of this book is on,
     and an unrecognised value falls back to it rather than to an empty board:
     a typo in a pasted link should cost a wrong ladder, not a screen that
     reads as a book with nothing in it. */
  const asked = salesTypeFrom(params.type);
  const salesType: LeadSalesType | null = asked === undefined ? "direct" : asked;

  const filters: LeadFilters = {
    owner: params.owner,
    source: params.source,
    stage: params.stage,
    potential: params.potential,
    next: params.next,
    age: params.age,
    health: params.health,
  };

  const day = await today();
  const config = await getConfig();

  const [board, options] = await Promise.all([
    leadBoard(day, {
      salesType,
      filters,
      health: {
        atRiskBelow: config["mbos.health.atRiskBelow"],
        strongAtOrAbove: config["mbos.health.strongAtOrAbove"],
      },
    }),
    leadFilterOptions(false),
  ]);

  return (
    <BoardScreen
      board={board}
      typeKey={salesType ?? LEGACY}
      filters={{
        owner: splitFilter(filters.owner),
        source: splitFilter(filters.source),
        stage: splitFilter(filters.stage),
        potential: splitFilter(filters.potential),
        next: splitFilter(filters.next),
        age: splitFilter(filters.age),
        health: splitFilter(filters.health),
      }}
      options={options}
      canWork={await canLead(user, "lead.work")}
      canOverride={(await canLead(user, "lead.override")) && config["leads.allowManagerOverride"]}
      overrideAllowed={config["leads.allowManagerOverride"]}
    />
  );
}
