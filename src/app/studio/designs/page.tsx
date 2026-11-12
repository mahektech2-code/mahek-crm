import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth";
import { stamp } from "@/lib/format";
import { designsFor, myDesignDrafts } from "@/lib/studio/service";
import { DesignGrid, DesignTile } from "../_ui/parts";
import { UploadForm } from "../_ui/upload-form";

export const metadata: Metadata = { title: "Designs" };
export const dynamic = "force-dynamic";

export default async function DesignsPage() {
  const user = await requireUser();
  const [designs, drafts] = await Promise.all([designsFor(), myDesignDrafts(user.id)]);
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader title="Designs" subtitle="The approved designs everybody makes posters from, and your own uploads. An upload is private to you until somebody who approves designs publishes it." />
      <h2 className="mb-2 text-base font-semibold text-ink">Upload your own</h2>
      <UploadForm />
      {drafts.length ? (
        <Card className="mt-4">
          <CardHeader title="Your uploads" />
          <ul className="divide-y divide-divider">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-2.5">
                <Link href={`/studio/designs/${d.id}`} className="min-w-0 flex-1 truncate text-sm font-medium">
                  {d.name}
                </Link>
                {d.status === "approved" ? <Badge tone="success">Approved {stamp(d.approvedAt)}</Badge> : <Badge tone="warn">Draft · waiting for approval</Badge>}
                <span className="text-[12.5px] text-muted">edited {stamp(d.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <h2 className="mt-6 mb-3 text-base font-semibold text-ink">Approved designs</h2>
      <DesignGrid>
        {designs.map((d) => (
          <DesignTile key={d.id} design={d} />
        ))}
      </DesignGrid>
    </div>
  );
}
