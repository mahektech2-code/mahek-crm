/*
 * The CRM's Sales Manager desk — the Telecaller desk's shape (queues, then
 * leads, then a record), over this manager's book and grouped by the salesman
 * who owns each lead. The scope is `customers.sales_manager_id` (an
 * administrator sees everything); it travels on the request — see
 * `lib/services/crm-sales-manager-scope.ts`.
 */
import { Dashboard } from "@/components/sales-lead-pipeline/desk/dashboard";
import { today } from "@/lib/recompute";
import { parseDeskView } from "@/lib/sales-lead-pipeline/desk";
import { pipelineDesk } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";
import { pipelineLinks } from "@/lib/sales-lead-pipeline/workspace";

export const metadata = { title: "Sales Manager desk — CRM — MahekOne" };
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const links = pipelineLinks("crm");
  const data = await pipelineDesk(await today());
  const q = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  return <Dashboard data={data} initialView={parseDeskView(raw)} initialQuery={q ?? ""} base={links.base} intakeHref={links.intake} />;
}
