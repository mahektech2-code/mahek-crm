import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Callout, Card, CardHeader, PageHeader, buttonClass } from "@/components/ui/primitives";
import { canOpenModule } from "@/lib/access";
import { resolveScope } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { waLink } from "@/lib/erp/engines/logistics";
import { stamp } from "@/lib/format";
import { downloadFilename } from "@/lib/studio/domain/caption";
import { LANGUAGE_NAMES, type Language } from "@/lib/studio/domain/language";
import { DNC_WARNING, getRecipient } from "@/lib/studio/recipients";
import { getStudioRegistry } from "@/lib/studio/registry-service";
import { captionFor, getPoster, posterShares } from "@/lib/studio/service";
import { PosterActions } from "../../_ui/poster-actions";

export const metadata: Metadata = { title: "Poster" };
export const dynamic = "force-dynamic";

const CHANNEL: Record<string, string> = { download: "Downloaded", whatsapp: "Opened WhatsApp", device: "Shared from the phone" };

export default async function PosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const poster = await getPoster(id);
  if (!poster || poster.removedAt) notFound();
  const { scope } = await resolveScope();
  const [registry, shares, recipient, canMake] = await Promise.all([
    getStudioRegistry(),
    posterShares(id),
    poster.customerId ? getRecipient(scope.userIds, poster.customerId) : null,
    canOpenModule(user.id, "studio.make"),
  ]);
  const t = registry.getVersion(poster.templateId, poster.templateVersion);
  const caption = t ? captionFor(poster, t.manifest.category) : null;
  const whatsappHref = recipient && !recipient.doNotContact && !recipient.whatsappDnd ? waLink(recipient.whatsappPhone, caption ?? "") : null;
  const whatsappBlocked = !recipient
    ? "The record this poster was made for is no longer in your book, so there is no number to open a chat on."
    : recipient.doNotContact
      ? "Marked Do Not Contact — no chat is offered."
      : recipient.whatsappDnd
        ? "They asked not to be messaged on WhatsApp — no chat is offered."
        : !whatsappHref
          ? "There is no usable phone number on their record."
          : null;
  const imageUrl = `/api/studio/posters/${encodeURIComponent(id)}/image`;
  const fileName = downloadFilename(poster.templateId, poster.recipient.company, poster.language, "png");

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href="/studio/posters">My posters</Link> / {poster.recipient.company}
      </div>
      <PageHeader
        title={poster.recipient.company}
        subtitle={`${poster.templateName} · ${LANGUAGE_NAMES[poster.language as Language] ?? poster.language} · made by ${poster.mine ? "you" : poster.createdByName} ${stamp(poster.createdAt)}`}
        subtitleShown
        actions={
          canMake && poster.customerId && recipient ? (
            <Link href={`/studio/make/${encodeURIComponent(poster.customerId)}`} className={buttonClass({ variant: "secondary" })}>
              Another for them
            </Link>
          ) : null
        }
      />
      {recipient?.doNotContact ? <Callout tone="danger">{DNC_WARNING}</Callout> : null}
      {!t ? <Callout tone="warn">The design this poster was made from is no longer available, so it cannot be drawn.</Callout> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="p-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- drawn by our own route from the stored recipe */}
          <img src={imageUrl} alt={`Poster for ${poster.recipient.company}`} className="mx-auto block max-h-[78vh] w-auto rounded-control" />
        </Card>
        <div className="flex flex-col gap-3">
          <PosterActions posterId={id} imageUrl={imageUrl} fileName={fileName} caption={caption} whatsappHref={whatsappHref} whatsappBlocked={whatsappBlocked} canRemove={poster.mine} />
          <Card>
            <CardHeader title="Sent" hint={shares.length ? undefined : "Nothing recorded yet."} />
            {shares.length ? (
              <ul className="divide-y divide-divider">
                {shares.map((s) => (
                  <li key={s.id} className="px-5 py-2 text-sm">
                    {CHANNEL[s.channel] ?? s.channel}
                    {s.format ? ` (${s.format === "jpeg" ? "JPG" : "PNG"})` : ""} · {s.by} · <span className="text-muted">{stamp(s.at)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
          <Card className="px-5 py-3 text-[13px] text-muted">
            {poster.wordingLabel ? <div>Greeting: {poster.wordingLabel === "Your own" ? "their own message" : poster.wordingLabel}</div> : null}
            {poster.recipient.product && poster.showProduct ? <div>Product: {poster.recipient.product.name}</div> : null}
            <div>
              Design version {poster.templateVersion} — this poster always draws from it, even after the design is refreshed.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
