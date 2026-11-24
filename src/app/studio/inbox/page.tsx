import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/primitives";
import { getConversation, listConversationRows, threadMessages } from "@/lib/studio/inbox-service";
import { publicConnection } from "@/lib/studio/inbox-view";
import { resolveStudioScope } from "@/lib/studio/scope";
import { InboxApp } from "../_ui/inbox-app";

export const metadata: Metadata = { title: "WhatsApp Inbox" };
export const dynamic = "force-dynamic";

/* The Studio's WhatsApp Inbox. Everything on it is read from what Kapso said
   about the company number — there is no sample data anywhere. Where Kapso is
   not ready the screen says what is missing instead of drawing a chat. */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  const sp = await searchParams;
  const open = Array.isArray(sp.c) ? sp.c[0] : sp.c;
  const { scope } = await resolveStudioScope();
  const { connection, rows } = await listConversationRows({ scopeIds: scope.userIds });
  const active = open ? await getConversation(open, scope.userIds) : null;
  const messages = active ? await threadMessages(active.id, scope.userIds) : [];
  return (
    <div className="mx-auto w-full min-w-0 px-6 py-6">
      <PageHeader title="WhatsApp Inbox" subtitle="Your leads' and customers' conversations on the company number — read and answered here, without leaving the Studio." />
      <InboxApp initial={JSON.parse(JSON.stringify({ connection: publicConnection(connection), conversations: rows, active, messages }))} openId={active?.id ?? null} />
    </div>
  );
}
