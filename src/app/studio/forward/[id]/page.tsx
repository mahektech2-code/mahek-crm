import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth";
import type { ForwardStatus } from "@/lib/studio/domain/forward";
import { forwardRecipients, getForward, imageUrlOf } from "@/lib/studio/forward-service";
import { ForwardRun } from "../../_ui/forward-run";
import { ForwardSetup } from "../../_ui/forward-setup";

export const metadata: Metadata = { title: "Upload & Bulk Forward" };
export const dynamic = "force-dynamic";

export default async function ForwardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const forward = await getForward(user.id, id);
  if (!forward) notFound();
  const imageUrl = imageUrlOf(forward.id);
  const rows = forward.status === "started" ? await forwardRecipients(forward.id) : [];
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href="/studio/forward">Upload &amp; Bulk Forward</Link> / {forward.title}
      </div>
      <PageHeader title={forward.title} subtitle={forward.status === "draft" ? "Choose who gets this poster." : "Work down the list. Nothing is sent by MahekOne."} subtitleShown />
      {forward.status === "draft" ? (
        <ForwardSetup forwardId={forward.id} title={forward.title} imageUrl={imageUrl} />
      ) : (
        <ForwardRun title={forward.title} imageUrl={imageUrl} rows={rows.map((r) => ({ id: r.id, company: r.company, place: r.place, status: r.status as ForwardStatus }))} />
      )}
    </div>
  );
}
