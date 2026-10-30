import { notFound, redirect } from "next/navigation";
import { today } from "@/lib/recompute";
import { pipelineLead } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";

export const metadata = { title: "Lead record — Sales Manager — CRM — MahekOne" };
export const dynamic = "force-dynamic";

/*
 * THE SALES MANAGER'S RECORD IS THE UNIFIED LEAD RECORD NOW — `/crm/leads/[id]`.
 *
 * This route stays for bookmarks, bells and the old desk rows, and it keeps
 * one job: the seat-scope read. `pipelineLead` answers null for a lead that is
 * not in this Sales Manager's book, which is the same 404 as a lead that does
 * not exist, so an out-of-book id is never handed on. The unified record then
 * keeps a manager who was not given All Leads on their seat too
 * (`holdsSeatWithoutAllLeads`). The old screen's components
 * (`components/sales-lead-pipeline/desk/*`) are left in place: the edit and
 * review pages beside this one still draw from them.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await pipelineLead(id, await today());
  if (!found) notFound();
  redirect(`/crm/leads/${encodeURIComponent(id)}`);
}
