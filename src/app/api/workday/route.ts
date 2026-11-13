import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { hrmsContext } from "@/lib/hrms/access";
import { workdayState } from "@/lib/hrms/services/workday";
import { beat, claimAutoOut, decideClaim, resumeWork, startBreak } from "@/lib/hrms/workday-ops";
import { hrmsCheckIn, hrmsCheckOut, hrmsRaiseLateHelp } from "@/lib/actions/hrms-checkin";

/* ---------------------------------------------------------------------------
 * THE WORKDAY CLOCK'S ONE DOOR. A route rather than server actions, because
 * the server refuses every server action while somebody is locked out — and
 * punching in, resuming from a break and punching out are the way out of the
 * lock. GET is the day as the screens draw it, settled as of now; POST does
 * one thing and answers with the day again, so a screen never has to ask
 * twice.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

async function signedIn() {
  return getCurrentUser();
}

export async function GET() {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const ctx = await hrmsContext();
  return NextResponse.json({ state: await workdayState(ctx) });
}

type Body =
  | { op: "beat" }
  | { op: "punchIn"; lat?: number | null; lng?: number | null; accuracy?: number | null }
  | { op: "punchOut"; lat?: number | null; lng?: number | null; accuracy?: number | null }
  | { op: "break"; reason?: string | null }
  | { op: "resume"; claim?: { category: string; note: string } | null }
  | { op: "claimOut"; category: string; note: string }
  | { op: "lateHelp"; text: string }
  | { op: "decide"; id: string; approve: boolean; note?: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function POST(req: Request) {
  if (!(await signedIn())) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "That request could not be read." }, { status: 400 });
  }
  const ctx = await hrmsContext();
  let result: unknown = null;
  switch (body.op) {
    case "beat":
      await beat(ctx);
      break;
    case "punchIn":
      result = await hrmsCheckIn({ lat: num(body.lat), lng: num(body.lng), accuracy: num(body.accuracy), photoId: null, code: null });
      break;
    case "punchOut":
      result = await hrmsCheckOut({ lat: num(body.lat), lng: num(body.lng), accuracy: num(body.accuracy), photoId: null });
      break;
    case "break":
      result = await startBreak(ctx, typeof body.reason === "string" ? body.reason : null);
      break;
    case "resume":
      result = await resumeWork(ctx, body.claim && typeof body.claim.note === "string" ? { category: String(body.claim.category ?? "Other"), note: body.claim.note } : null);
      break;
    case "claimOut":
      result = await claimAutoOut(ctx, { category: String(body.category ?? "Other"), note: String(body.note ?? "") });
      break;
    case "lateHelp":
      result = await hrmsRaiseLateHelp(String(body.text ?? ""));
      break;
    case "decide":
      result = await decideClaim(ctx, String(body.id), !!body.approve, String(body.note ?? ""));
      break;
    default:
      return NextResponse.json({ error: "Unknown request." }, { status: 400 });
  }
  return NextResponse.json({ result, state: await workdayState(ctx) });
}
