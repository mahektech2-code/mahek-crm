import { NextResponse } from "next/server";
import { authenticate } from "@/lib/services/mbos-service";
import { handsetReadingForRange } from "@/lib/services/performance-service";
import { today } from "@/lib/recompute";

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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Five years is every question anybody has asked of this book, and a bound on the work. */
const MAX_DAYS = 5 * 366;

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  let to = url.searchParams.get("to") ?? "";
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) {
    return NextResponse.json(
      { ok: false, error: "Pick a start date on or before the end date." },
      { status: 400 },
    );
  }

  /* The future has no figures in it. Clamped rather than refused, so "this
     year" asked on any day means up to today. */
  const now = await today();
  if (to > now) to = now;
  if (from > to) {
    return NextResponse.json(
      { ok: false, error: "That range has not started yet." },
      { status: 400 },
    );
  }
  const span =
    (Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) -
      Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) /
    86_400_000;
  if (span > MAX_DAYS) {
    return NextResponse.json(
      { ok: false, error: "Pick a range of five years or less." },
      { status: 400 },
    );
  }

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
