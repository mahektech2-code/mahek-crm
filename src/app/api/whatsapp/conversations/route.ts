import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { whatsappLevel } from "@/lib/access";
import { listConversations, type ChatShow } from "@/lib/services/whatsapp-chat-service";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** The conversation list, re-read by the chat screen whenever the stream says something moved. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });
  if ((await whatsappLevel(user.id)) === "none") {
    return NextResponse.json({ error: "not yours" }, { status: 403, ...NO_STORE });
  }
  const params = new URL(request.url).searchParams;
  const raw = params.get("show");
  const show: ChatShow = raw === "all" || raw === "unknown" ? raw : "open";
  return NextResponse.json(await listConversations({ show, q: params.get("q") ?? "" }), NO_STORE);
}
