import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/primitives";
import { resolveScope } from "@/lib/access-control";
import { getRecipient } from "@/lib/studio/recipients";
import { getPoster } from "@/lib/studio/service";
import { conversationForNumber, getConversation, listConversationRows, threadMessages } from "@/lib/studio/inbox-service";
import { publicConnection } from "@/lib/studio/inbox-view";
import { resolveStudioScope } from "@/lib/studio/scope";
import { InboxApp } from "../_ui/inbox-app";

export const metadata: Metadata = { title: "WhatsApp Inbox" };
export const dynamic = "force-dynamic";

/* The Studio's WhatsApp Inbox. Everything on it is read from what Kapso said
   about the company number — there is no sample data anywhere. Where Kapso is
   not ready the screen says what is missing instead of drawing a chat. */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ c?: string | string[]; poster?: string | string[]; start?: string | string[]; new?: string | string[] }> }) {
  const sp = await searchParams;
  const open = Array.isArray(sp.c) ? sp.c[0] : sp.c;
  const posterParam = Array.isArray(sp.poster) ? sp.poster[0] : sp.poster;
  const startParam = Array.isArray(sp.start) ? sp.start[0] : sp.start;
  const { scope } = await resolveStudioScope();
  /* `start` is a poster whose customer has no chat yet. Once they have one, the address leads to it. */
  const starting = startParam && !open ? await getPoster(startParam) : null;
  /* `new` is a person with no chat and no single poster: a row of a bulk forward. getRecipient is the scope check. */
  const newParam = Array.isArray(sp.new) ? sp.new[0] : sp.new;
  const customerId = starting && !starting.removedAt ? starting.customerId : open ? null : newParam;
  const person = customerId ? await getRecipient((await resolveScope()).scope.userIds, customerId) : null;
  const existing = person ? await conversationForNumber(person.whatsappPhone, scope.userIds) : null;
  if (existing) redirect(`/studio/inbox?c=${encodeURIComponent(existing.id)}${starting && existing.windowOpen ? `&poster=${encodeURIComponent(starting.id)}` : ""}`);
  const { connection, rows } = await listConversationRows({ scopeIds: scope.userIds });
  const active = open ? await getConversation(open, scope.userIds) : null;
  const messages = active ? await threadMessages(active.id, scope.userIds) : [];
  /* A poster named in the address is offered as ready to send in that conversation. getPoster is the scope check, so
     one the person may not open is simply not offered. */
  const poster = active && posterParam ? await getPoster(posterParam) : null;
  const readyPoster = poster && !poster.removedAt ? { id: poster.id, title: poster.recipient.company, sub: poster.templateName, thumb: `/api/studio/posters/${encodeURIComponent(poster.id)}/image?format=jpeg` } : null;
  const newChat = person?.whatsappPhone
    ? { title: person.company, phone: person.whatsappPhone, poster: starting ? { id: starting.id, thumb: `/api/studio/posters/${encodeURIComponent(starting.id)}/image?format=jpeg` } : null }
    : null;
  return (
    <div className="mx-auto w-full min-w-0 px-6 py-6">
      <PageHeader title="WhatsApp Inbox" subtitle="Your leads' and customers' conversations on the company number — read and answered here, without leaving the Studio." />
      <InboxApp initial={JSON.parse(JSON.stringify({ connection: publicConnection(connection), conversations: rows, active, messages }))} openId={active?.id ?? null} readyPoster={readyPoster} newChat={newChat} />
    </div>
  );
}
