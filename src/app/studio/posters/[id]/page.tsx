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
import { conversationForNumber, posterTemplateConfig } from "@/lib/studio/inbox-service";
import { resolveStudioScope } from "@/lib/studio/scope";
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
  /* Where the person holds the Inbox, sending belongs there: the poster goes through Kapso and its ticks are tracked. It only
     works inside the customer's 24-hour reply window, so the button is offered only then, and the reason is said otherwise. */
  let inboxHref: string | null = null;
  let inboxNote: string | null = null;
  let templateSend = false;
  /* Where the Inbox cannot send yet, the chat button still opens in the Studio rather than leaving for WhatsApp. */
  let studioChatHref: string | null = null;
  if (recipient && !recipient.doNotContact && !recipient.whatsappDnd && (await canOpenModule(user.id, "studio.inbox"))) {
    const studio = await resolveStudioScope();
    const conv = await conversationForNumber(recipient.whatsappPhone, studio.scope.userIds);
    const template = await posterTemplateConfig();
    if (conv?.blocked) {
      inboxNote = null;
    } else if (conv?.windowOpen) {
      inboxHref = `/studio/inbox?c=${encodeURIComponent(conv.id)}&poster=${encodeURIComponent(id)}`;
    } else if (template) {
      /* Outside the 24-hour window WhatsApp takes only an approved template, and that is what the button sends. */
      templateSend = true;
      inboxNote = conv
        ? "Their 24-hour reply window is closed, so the poster goes as the approved template message instead of a free message."
        : "They have not messaged the company number yet, so the poster goes as the approved template message and the chat then opens in the Inbox.";
    } else {
      /* No poster is named for a closed chat: naming one opens the send dialog, which could not send it. */
      if (whatsappHref) studioChatHref = conv ? `/studio/inbox?c=${encodeURIComponent(conv.id)}` : `/studio/inbox?start=${encodeURIComponent(id)}`;
      inboxNote = (conv ? "Their 24-hour reply window is closed" : "They have not messaged the company number yet") + ", and no approved WhatsApp template is set up for posters, so the Inbox cannot send this. An administrator can set one up in Settings.";
    }
  }
  const imageUrl = `/api/studio/posters/${encodeURIComponent(id)}/image`;
  const fileName = downloadFilename(poster.templateId, poster.recipient.company, poster.language, "png");

  return (
    <div className="mx-auto w-full min-w-0 px-6 py-6">
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
          <PosterActions posterId={id} imageUrl={imageUrl} fileName={fileName} caption={caption} whatsappHref={whatsappHref} whatsappBlocked={whatsappBlocked} inboxHref={inboxHref} inboxNote={inboxNote} studioChatHref={studioChatHref} templateSend={templateSend} canRemove={poster.mine} />
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
