import { NextResponse } from "next/server";
import { hireContext } from "@/lib/hire/access";
import { mintRealtimeSession } from "@/lib/hire/services/voice";

/**
 * A ten-minute client secret for one AI voice screen. The server key never
 * leaves the server; the browser talks to the Realtime API with this alone.
 */
export async function POST(req: Request) {
  const ctx = await hireContext();
  if (!ctx || !ctx.can("interview")) return NextResponse.json({ ok: false, error: "Running a screen needs an interviewing role in Hire." }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { execId?: string } | null;
  if (!body?.execId) return NextResponse.json({ ok: false, error: "Which screen?" }, { status: 400 });
  const r = await mintRealtimeSession(ctx, body.execId);
  return NextResponse.json(r, { status: r.ok ? 200 : 422 });
}
