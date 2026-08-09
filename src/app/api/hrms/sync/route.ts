import { NextResponse } from "next/server";
import { runJob } from "@/lib/jobs";

/* ---------------------------------------------------------------------------
 * The scheduled half of "the sheet stays level with the app".
 *
 * The screen syncs while somebody is looking at it, which covers the case that
 * matters most — HR adds a row and wants to see it. This covers the rest: the
 * sheet changes at four in the afternoon and nobody opens HRMS until Monday,
 * and Monday's screen should already be right rather than right after a wait.
 *
 * It is not open. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, and
 * without a secret configured the route refuses rather than running — an
 * unauthenticated endpoint that reads somebody's payroll into the database on
 * request is not a default anybody should get by forgetting a variable.
 * ------------------------------------------------------------------------- */

// A sheet read and a batch of writes: never a cached response, never
// prerendered at build time.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not set, so this endpoint is closed." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 401 });
  }

  try {
    const [result] = await runJob("hrms-sync");
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // The job row already carries the failure; this is what the cron log sees.
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
