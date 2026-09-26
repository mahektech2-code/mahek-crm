import { ListScreen } from "@/components/sales-lead-pipeline/list-screen";
import { today } from "@/lib/recompute";
import { pipelineList } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

export const metadata = { title: "All Leads — Sales Manager — MahekOne" };
export const dynamic = "force-dynamic";

const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * SEARCH, FILTER AND PAGE ARE IN THE URL, and the server does all three. The
 * book is thousands of leads; the browser is handed one page of it and a count.
 * A hand-typed `page` is clamped by `leadsPage` itself.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = { q: single(sp.q).trim(), stage: single(sp.stage), view: single(sp.view) || single(sp.due) };
  const page = Number.parseInt(single(sp.page), 10);
  const day = await today();
  const data = await pipelineList(day, { ...params, page: Number.isFinite(page) && page > 0 ? page : 1 });
  return <ListScreen data={data} params={params} />;
}
