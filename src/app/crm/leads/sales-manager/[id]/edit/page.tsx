import { notFound } from "next/navigation";

import { SalesManagerEditForm } from "@/components/sales-lead-pipeline/desk/edit-form";
import { today } from "@/lib/recompute";
import { pipelineLead, pipelineRefs } from "@/lib/sales-lead-pipeline/sales-manager-pipeline-service";
import { leadManagerCandidatesFor } from "@/lib/services/lead-service";

export const metadata = { title: "Edit lead — Sales Manager — CRM — MahekOne" };
export const dynamic = "force-dynamic";

/**
 * The Sales Manager's own Edit — six fields, inside the workspace.
 *
 * It lives under `/crm/leads/sales-manager`, so the module guard in that
 * folder's layout and the seat scope (`sales_manager_id = me`) both apply with
 * nothing repeated here: `pipelineLead` answers null for a lead outside the
 * book, and that is a 404 for the same reason the record's is. The write is
 * `editLeadBasics`, which asks the same scope again — this page is not the
 * authority, only the form.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await pipelineLead(id, await today());
  if (!found) notFound();

  const [refs, candidates] = await Promise.all([pipelineRefs(), leadManagerCandidatesFor(id)]);

  /* The current holder is always offered, even where they would not be picked
     today (a retired territory, say), so the box never opens on a name that
     is not in it and a save cannot silently move it. */
  const managers = candidates.map((c) => ({ id: c.id, name: c.name }));
  const lead = found.lead;
  if (lead.managerId && !managers.some((m) => m.id === lead.managerId)) {
    managers.unshift({ id: lead.managerId, name: lead.manager || "Current sales manager" });
  }
  const salesmen = refs.salesmen.map((s) => ({ id: s.id, name: s.name }));
  if (lead.ownerId && !salesmen.some((s) => s.id === lead.ownerId)) {
    salesmen.unshift({ id: lead.ownerId, name: lead.owner || "Current owner" });
  }

  return (
    <SalesManagerEditForm
      lead={{
        id: lead.id,
        name: lead.name,
        ownerId: lead.ownerId ?? "",
        managerId: lead.managerId ?? "",
        city: lead.city ?? "",
        contact: lead.contact ?? "",
        phone: lead.phone ?? "",
        productId: lead.productId ?? null,
        product: lead.product ?? null,
        lost: Boolean(lead.lost),
        canWork: lead.caps.canWork,
      }}
      salesmen={salesmen}
      managers={managers}
    />
  );
}
