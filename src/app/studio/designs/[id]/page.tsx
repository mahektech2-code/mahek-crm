import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Callout, PageHeader } from "@/components/ui/primitives";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { parsePlacement } from "@/lib/studio/domain/template-upload";
import { getStudioRegistry } from "@/lib/studio/registry-service";
import { getDesignRow } from "@/lib/studio/service";
import { DesignEditor } from "../../_ui/design-editor";

export const metadata: Metadata = { title: "Place fields" };
export const dynamic = "force-dynamic";

export default async function DesignDraft({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const row = await getDesignRow(id);
  const approver = await canOpenModule(user.id, "studio.approve");
  if (!row || (row.createdById !== user.id && !approver)) notFound();
  const parsed = parsePlacement(row.placement);
  if (!parsed.ok) notFound();
  const registry = await getStudioRegistry();
  const occasions = registry.occasions().map((o) => ({ id: o.id, label: o.label }));
  return (
    <div className="mx-auto max-w-[1280px] px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href={approver && row.createdById !== user.id ? "/studio/approvals" : "/studio/designs"}>{approver && row.createdById !== user.id ? "Approve designs" : "Designs"}</Link> / {row.name}
      </div>
      <PageHeader title={row.name} subtitle="Drag the boxes where the text should go. Everything on the boxes is sample text; Preview draws it with the real renderer." />
      {row.status === "approved" ? <Callout tone="info">This design is approved and can no longer be changed. Upload it again to make a revised version.</Callout> : null}
      <DesignEditor draftId={row.id} initial={parsed.draft} occasions={occasions} approved={row.status !== "draft"} owner={row.createdById === user.id} canApprove={approver} />
    </div>
  );
}
