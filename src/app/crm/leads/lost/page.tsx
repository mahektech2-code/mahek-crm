/*
 * A CENTRAL RECORD OF EVERY LEAD CLOSED LOST, whatever rung it was lost from.
 *
 * `crm.lead-lost` guards this route (see `layout.tsx`), and §26's own stage
 * machinery — `lead_stage = 'lost'`, `lead_lost_reason`, and the closing row in
 * `lead_stage_transitions` — already carries everything this screen shows.
 * Nothing here writes a lead lost; that stays where it is, on the record's own
 * form, through the same gate every other stage move runs.
 */
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import {
  lostLeadOwnerOptions,
  lostLeadsPage,
  lostLeadTiles,
  LOST_LEADS_PER_PAGE,
  type LostLeadFilters,
} from "@/lib/services/lead-lost-service";
import { splitFilter } from "@/lib/lead-filters";
import { LostLeadsScreen } from "@/components/leads/lost/lost-leads-screen";

export const metadata = { title: "Lost — Lead Management — CRM — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;

  const filters: LostLeadFilters = {
    /* Capped, like every search box in this workspace — a search box is a
       text field on a URL anybody can write. */
    search: params.q?.slice(0, 200),
    owner: params.owner,
    salesType: params.salesType,
    fromStage: params.fromStage,
    reason: params.reason,
    lostFrom: params.lostFrom,
    lostTo: params.lostTo,
  };

  const day = await today();
  const [page, owners, tiles] = await Promise.all([
    lostLeadsPage({
      filters,
      page: Number(params.page) || 1,
      perPage: Number(params.per) || LOST_LEADS_PER_PAGE,
    }),
    lostLeadOwnerOptions(),
    lostLeadTiles(day),
  ]);

  return (
    <LostLeadsScreen
      workspace="crm"
      leads={page.rows}
      pageInfo={{
        page: page.page,
        pageCount: page.pageCount,
        perPage: page.perPage,
        total: page.total,
        listTotal: page.listTotal,
      }}
      filters={{
        owner: splitFilter(filters.owner),
        salesType: splitFilter(filters.salesType),
        fromStage: splitFilter(filters.fromStage),
        reason: splitFilter(filters.reason),
        lostFrom: filters.lostFrom ?? "",
        lostTo: filters.lostTo ?? "",
      }}
      ownerOptions={owners}
      tiles={tiles}
    />
  );
}
