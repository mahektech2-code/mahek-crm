import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { getThread } from "@/lib/services/whatsapp-chat-service";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * One conversation, both directions. Out of scope and missing answer alike —
 * 404 — so this cannot be used to find out which customers exist.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });
  if (!(await canOpenModule(user.id, "crm.whatsapp"))) {
    return NextResponse.json({ error: "not yours" }, { status: 403, ...NO_STORE });
  }
  const key = new URL(request.url).searchParams.get("key") ?? "";
  try {
    const r = await getThread(key);
    if (!r.ok) return NextResponse.json({ error: "not found" }, { status: 404, ...NO_STORE });
    return NextResponse.json(r.data, NO_STORE);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404, ...NO_STORE });
  }
}
