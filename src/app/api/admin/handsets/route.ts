import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/access-control";
import { listHandsets } from "@/lib/services/handset-version-service";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * The Admin Console's Handsets table, read every few seconds while it is open.
 * Platform administrators only — the same grant the console's platform
 * sections sit behind — because it lists every salesman's phone.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });
  if (!(await isPlatformAdmin(user))) {
    return NextResponse.json({ error: "Only a platform administrator can see the handsets." }, { status: 403, ...NO_STORE });
  }
  return NextResponse.json(await listHandsets(), NO_STORE);
}
