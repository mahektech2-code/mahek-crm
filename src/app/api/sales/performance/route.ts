import { NextResponse } from "next/server";
import { canOpenModule } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { checkRange } from "@/lib/performance-range";
import { today } from "@/lib/recompute";
import { personPerformance } from "@/lib/services/performance-service";

/* ---------------------------------------------------------------------------
 * One person's performance over any range, for the Sales Dashboard's person
 * modal on the Performance screen.
 *
 * Behind the SAME door as the screen it is opened from — the
 * `sales.performance` module — because that screen already lists every
 * person's month to whoever holds it, and this answers nothing that screen
 * does not, only in more depth and over more days.
 *
 * The score is `scoreRange`, the computation the handset's own range reading
 * uses, so a salesman's phone and his manager's modal print one number.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again." }, { status: 401 });
  if (!(await canOpenModule(user.id, "sales.performance"))) {
    return NextResponse.json({ ok: false, error: "Performance is not on your account." }, { status: 403 });
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? "";
  const now = await today();
  const checked = checkRange(url.searchParams.get("from"), url.searchParams.get("to"), now);
  if (!userId) return NextResponse.json({ ok: false, error: "Nobody was named." }, { status: 400 });
  if (!checked.ok) return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });

  try {
    const reading = await personPerformance(userId, checked.range.from, checked.range.to, now);
    if (!reading) return NextResponse.json({ ok: false, error: "That person is not on MahekOne." }, { status: 404 });
    return NextResponse.json({ ok: true, reading });
  } catch (e) {
    console.error("Person performance failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: "MahekOne could not work that out just now. Try again in a moment." },
      { status: 500 },
    );
  }
}
