/*
 * A CENTRAL RECORD OF EVERY LEAD CLOSED LOST, whatever rung it was lost from.
 *
 * `crm.lead-lost` guards this route (see `layout.tsx`), and §26's own stage
 * machinery — `lead_stage = 'lost'`, `lead_lost_reason`, and the closing row in
 * `lead_stage_transitions` — already carries everything this screen shows.
 * Nothing here writes a lead lost; that stays where it is, on the record's own
 * form, through the same gate every other stage move runs. The one write on this
 * page is Reverse, offered only to somebody holding one of its two doors.
 */
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { canOpenModule } from "@/lib/access";
import { getConfig } from "@/lib/config/store";
import type { ReopenOffer } from "@/components/leads/lost/reopen-lost-dialog";
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
  const user = await requireUser();
  const params = await searchParams;

  /* Reading this list is not a permission to reverse anything. The column is
     drawn only for somebody holding one of the two doors, and each door is a
     server action that asks its own question again:
       - the Sales Manager's `lead.verify`, or
       - the Calling desk grant with `lead.work` (the Telecaller's).
     A manager who also holds the desk is offered the Sales Manager's door, the
     wider of the two. */
  const [isSalesManager, holdsDesk, canWork, config] = await Promise.all([
    canFor(user, "lead.verify"),
    canOpenModule(user.id, "crm.lead-calling-desk"),
    canFor(user, "lead.work"),
    getConfig(),
  ]);
  const reopen: ReopenOffer | null =
    isSalesManager || (holdsDesk && canWork)
      ? {
          seat: isSalesManager ? "sales_manager" : "calling_desk",
          reasons: config["leads.reopenReasons"].map((r) => ({ code: r.code, label: r.label })),
        }
      : null;

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
      reopen={reopen}
    />
  );
}
