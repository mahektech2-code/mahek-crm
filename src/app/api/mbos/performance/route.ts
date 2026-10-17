import { NextResponse } from "next/server";
import { authenticate } from "@/lib/services/mbos-service";
import { handsetReadingForRange } from "@/lib/services/performance-service";
import { today } from "@/lib/recompute";
import { checkRange } from "@/lib/performance-range";

/* ---------------------------------------------------------------------------
 * A salesman's own performance over any range of days — this quarter, last
 * financial year, a fortnight he picked.
 *
 * The sync carries the two months that matter most, so the screen opens on
 * those with no signal at all. Anything wider is asked for here, because it is
 * a reading of the ledger over a window nobody could have guessed in advance,
 * and caching every possible range on every phone is not a thing.
 *
 * IT TAKES NO USER. The person is whoever the device token belongs to — the
 * same rule `crm.performance` follows on the web — so this cannot be turned
 * into a way to read a colleague's appraisal by changing a parameter.
 *
 * It READS and writes nothing: the monthly cache stays the nightly job's.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  /* Checked, and NEVER clamped to today — see `lib/performance-range.ts`.
     Clamping cut this month's target to the days already gone and scored the
     phone several times higher than the Performance screen. */
  const url = new URL(request.url);
  const checked = checkRange(url.searchParams.get("from"), url.searchParams.get("to"), await today());
  if (!checked.ok) {
    return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });
  }
  const { from, to } = checked.range;

  try {
    const reading = await handsetReadingForRange(auth.principal.user.id, from, to);
    return NextResponse.json({ ok: true, reading });
  } catch (e) {
    console.error("Performance range failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: "MahekOne could not work that out just now. Try again in a moment." },
      { status: 500 },
    );
  }
}
