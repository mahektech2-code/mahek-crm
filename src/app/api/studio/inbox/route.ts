import { NextResponse } from "next/server";
import { getConversation, listConversationRows, threadMessages } from "@/lib/studio/inbox-service";
import { studioCaller } from "@/lib/studio/http";
import { publicConnection } from "@/lib/studio/inbox-view";

/* What the Inbox screen polls: the conversation list, and — for the one that
   is open — its messages. Whoever holds the WhatsApp Inbox sees every
   conversation; nobody else gets an answer. */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caller = await studioCaller("studio.inbox");
  if ("response" in caller) return caller.response;
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const open = url.searchParams.get("c");
  const { connection, rows } = await listConversationRows({ q });
  const active = open ? await getConversation(open) : null;
  const messages = active ? await threadMessages(active.id) : [];
  return NextResponse.json({ ok: true, connection: publicConnection(connection), conversations: rows, active, messages }, { headers: { "Cache-Control": "no-store" } });
}
