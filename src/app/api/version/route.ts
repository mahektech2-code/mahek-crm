import { NextResponse } from "next/server";

/* ---------------------------------------------------------------------------
 * WHICH BUILD IS SERVING. Read by `VersionGuard` in every open tab, so it must
 * cost nothing: no database, no session, no work. It names a commit sha, which
 * is already on every asset URL as `?dpl=`, so answering without
 * authentication leaks nothing new. The same inlined constant the page reads,
 * so the two sides cannot disagree about how the id is spelled.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { id: process.env.MAHEK_BUILD ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
