import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Callout, Card, PageHeader } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth";
import { stamp } from "@/lib/format";
import { myForwards, imageUrlOf } from "@/lib/studio/forward-service";
import { ForwardUpload } from "../_ui/forward-upload";

export const metadata: Metadata = { title: "Upload & Bulk Forward" };
export const dynamic = "force-dynamic";

export default async function ForwardHome() {
  const user = await requireUser();
  const forwards = await myForwards(user.id);
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader title="Upload & Bulk Forward" subtitle="Upload a finished poster and forward the same picture, unchanged, to many of your own leads and customers." subtitleShown />
      <Callout tone="info">MahekOne does not send WhatsApp messages itself. For each person it opens their chat with your message written; you attach the poster and press send, then mark it done here.</Callout>
      <div className="mt-4">
        <ForwardUpload />
      </div>
      <h2 className="mb-2 mt-6 text-sm font-semibold text-ink">Your uploaded posters</h2>
      {!forwards.length ? (
        <p className="text-sm text-muted">Nothing uploaded yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {forwards.map((f) => (
            <Link key={f.id} href={`/studio/forward/${f.id}`} className="no-underline hover:no-underline">
              <Card className="overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded poster, served by our own route */}
                <img src={imageUrlOf(f.id)} alt={f.title} className="aspect-square w-full bg-surface-2 object-contain" />
                <div className="p-3">
                  <div className="truncate text-sm font-medium text-ink">{f.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
                    {f.status === "draft" ? <Badge tone="warn">Not started</Badge> : <Badge tone="brand">{f.tally.sent} of {f.tally.total} marked sent</Badge>}
                    <span>{stamp(f.createdAt)}</span>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
