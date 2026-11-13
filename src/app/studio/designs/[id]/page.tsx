import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Callout, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { parsePlacement } from "@/lib/studio/domain/template-upload";
import { getStudioRegistry } from "@/lib/studio/registry-service";
import { stamp } from "@/lib/format";
import { designVersions, getDesignRow } from "@/lib/studio/service";
import { DesignEditor } from "../../_ui/design-editor";
import { ReviseButton } from "../../_ui/revise";
import { UploadForm } from "../../_ui/upload-form";

export const metadata: Metadata = { title: "Place fields" };
export const dynamic = "force-dynamic";

export default async function DesignDraft({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const row = await getDesignRow(id);
  const approver = await canOpenModule(user.id, "studio.approve");
  const immediate = Boolean((await getConfig())["studio.publishImmediately"]);
  if (!row || (row.createdById !== user.id && !approver)) notFound();
  const parsed = parsePlacement(row.placement);
  if (!parsed.ok) notFound();
  const registry = await getStudioRegistry();
  const occasions = registry.occasions().map((o) => ({ id: o.id, label: o.label }));
  const published = row.status === "approved";
  const versions = row.status === "draft" ? [] : await designVersions(row.id);
  return (
    <div className="mx-auto max-w-[1280px] px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href={approver && row.createdById !== user.id ? "/studio/approvals" : "/studio/designs"}>{approver && row.createdById !== user.id ? "Approve designs" : "Designs"}</Link> / {row.name}
      </div>
      <PageHeader title={row.name} subtitle="Drag the boxes where the text should go. Everything on the boxes is sample text; Preview draws it with the real renderer." />
      {row.revisesId ? <Callout tone="info">This is a new version of a published design. Publishing it moves that design to its next version; posters already made from the version it replaces are unchanged.</Callout> : null}
      {published ? <Callout tone="info">This design is published and a published version never changes. To change it, create a new version below.</Callout> : null}
      {row.status === "archived" ? <Callout tone="warn">This design is archived. Restore it from the library to offer it again or to create a new version.</Callout> : null}
      {versions.length ? (
        <Card className="mb-4">
          <CardHeader title="Versions" hint="Every version is kept, because a poster always draws from the version it was made with." />
          <ul className="divide-y divide-divider">
            {versions.map((v) => (
              <li key={v.version} className="flex items-center gap-3 px-5 py-2 text-sm">
                <a href={`/api/studio/designs/${encodeURIComponent(row.id)}/preview?v=${encodeURIComponent(v.version)}`} target="_blank" rel="noreferrer" className="font-medium">
                  Version {v.version}
                </a>
                <span className="text-muted">{v.current ? "current" : "earlier"}</span>
                <span className="text-[12.5px] text-muted">
                  {v.at ? stamp(v.at) : ""}
                  {v.by ? ` · ${v.by}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {published ? (
            <div className="flex flex-wrap items-end gap-3 border-t border-divider px-5 py-3">
              <ReviseButton designId={row.id} />
              <UploadForm revisesId={row.id} />
            </div>
          ) : null}
        </Card>
      ) : null}
      <DesignEditor draftId={row.id} initial={parsed.draft} occasions={occasions} approved={row.status !== "draft"} owner={row.createdById === user.id} canApprove={approver} canPublish={immediate && row.createdById === user.id} />
    </div>
  );
}
