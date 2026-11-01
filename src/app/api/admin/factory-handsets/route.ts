import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/access-control";
import { listFactoryHandsets } from "@/lib/services/factory-handset-service";

export const dynamic = "force-dynamic";
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/**
 * The Admin Console's Factory handsets table, read every few seconds while it
 * is open. Platform administrators only, like the MBOS Handsets beside it.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });
  if (!(await isPlatformAdmin(user))) {
    return NextResponse.json({ error: "Only a platform administrator can see the factory handsets." }, { status: 403, ...NO_STORE });
  }
  return NextResponse.json(await listFactoryHandsets(), NO_STORE);
}
