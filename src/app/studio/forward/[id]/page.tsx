import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth";
import type { ForwardStatus } from "@/lib/studio/domain/forward";
import { forwardRecipients, getForward, imageUrlOf } from "@/lib/studio/forward-service";
import { ForwardRun } from "../../_ui/forward-run";
import { ForwardSetup } from "../../_ui/forward-setup";
import { CancelForwardButton } from "../../_ui/cancel-buttons";

export const metadata: Metadata = { title: "Upload & Bulk Forward" };
export const dynamic = "force-dynamic";

export default async function ForwardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const forward = await getForward(user.id, id);
  if (!forward) notFound();
  const imageUrl = imageUrlOf(forward.id);
  const rows = forward.status === "draft" ? [] : await forwardRecipients(forward.id);
  const notDone = rows.filter((r) => r.status === "pending" || r.status === "opened").length;
  const sent = rows.filter((r) => r.status === "sent").length;
  return (
    <div className="mx-auto w-full min-w-0 px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href="/studio/forward">Upload &amp; Bulk Forward</Link> / {forward.title}
      </div>
      <PageHeader
        title={forward.title}
        subtitle={forward.status === "cancelled" ? "Cancelled. What was already sent stays sent." : forward.status === "draft" ? "Choose who gets this poster." : "Work down the list. Nothing is sent by MahekOne."}
        subtitleShown
        actions={forward.status === "cancelled" ? undefined : <CancelForwardButton id={forward.id} started={forward.status === "started"} notDone={notDone} sent={sent} />}
      />
      {forward.status === "cancelled" && !rows.length ? null : forward.status === "draft" ? (
        <ForwardSetup forwardId={forward.id} title={forward.title} imageUrl={imageUrl} />
      ) : (
        <ForwardRun title={forward.title} imageUrl={imageUrl} cancelled={forward.status === "cancelled"} rows={rows.map((r) => ({ id: r.id, company: r.company, place: r.place, status: r.status as ForwardStatus }))} />
      )}
    </div>
  );
}
