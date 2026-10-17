import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { trashHistory } from "@/lib/services/lead-trash-service";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** Every time one lead went into the trash and came back out. Administrators only. */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });
  if (!(await canFor(user, "lead.restore"))) {
    return NextResponse.json({ error: "not yours" }, { status: 403, ...NO_STORE });
  }
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const rows = await trashHistory(id);
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      reason: r.reason,
      actorName: r.actorName,
      at: r.createdAt.toISOString(),
    })),
    NO_STORE,
  );
}
