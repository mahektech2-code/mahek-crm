import { ProtoList, type ProtoViewKey } from "@/components/sales-lead-pipeline/proto/list";
import { today } from "@/lib/recompute";
import { pipelineList, pipelineRefs } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

/**
 * The five list views of the Sales Manager sidebar, one server render.
 *
 * WHICH VIEW is the route; everything else is the URL's, and the server does
 * all the narrowing and counts the page in SQL. `mine`, `today` and `overdue`
 * are the real `LeadView`s the dashboard tiles already count; `distributors`
 * is the same book narrowed to the distributor and third-party ladders — a
 * filter the person can widen or narrow from the Sales type box, not a
 * separate population.
 */

const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export async function ProtoListPage({
  viewKey,
  searchParams,
}: {
  viewKey: ProtoViewKey;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const sp = searchParams;
  const params = {
    q: single(sp.q).trim(),
    salesType: single(sp.salesType),
    stage: single(sp.stage),
    owner: single(sp.owner),
    priority: single(sp.priority),
    /* Only the All Leads route carries a view of its own (`expected`, `lost30`
       — the dashboard tiles that have no sidebar link); the others ARE a view. */
    view: viewKey === "all" ? single(sp.view) : "",
  };
  const page = Number.parseInt(single(sp.page), 10);
  const day = await today();

  const view = viewKey === "mine" || viewKey === "today" || viewKey === "overdue" ? viewKey : params.view;
  const salesType = params.salesType || (viewKey === "distributors" ? "distributor,third_party" : "");

  const [data, refs] = await Promise.all([
    pipelineList(day, { ...params, salesType, view, page: Number.isFinite(page) && page > 0 ? page : 1 }),
    pipelineRefs(),
  ]);

  return <ProtoList data={data} params={params} viewKey={viewKey} day={day} owners={refs.salesmen} />;
}
