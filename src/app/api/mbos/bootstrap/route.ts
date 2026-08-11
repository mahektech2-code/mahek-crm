import { NextResponse } from "next/server";
import { authenticate, buildBootstrap } from "@/lib/services/mbos-service";

/* ---------------------------------------------------------------------------
 * The snapshot — PROTOCOL.md §4 and brief §3.1.
 *
 * The only call that may be large. Everything after it is a delta on the
 * cursor this returns, which is why the cursor is issued here rather than
 * being something the handset has to construct.
 *
 * It is SCOPED, and the scope is not this route's to invent: the service reads
 * `ASSIGNED_TO_SQL` and `scopeForUser`, the same two things every CRM list
 * reads. And internal notes are not in it — not filtered out on the way to the
 * screen, not written to the device at all, because a note that could leak is
 * not on the handset to leak (§6.3, PROTOCOL §9).
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

/** A first bootstrap on a full book is a lot of rows and one long query set. */
export const maxDuration = 120;

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  try {
    const payload = await buildBootstrap(auth.principal);
    return NextResponse.json({ ok: true, ...payload });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "bootstrap_failed",
        error: `Your book could not be loaded: ${
          e instanceof Error ? e.message : "the server did not answer"
        }.`,
      },
      { status: 503 },
    );
  }
}
