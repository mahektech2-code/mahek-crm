import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { dayEvidence } from "@/lib/services/day-evidence-service";

/**
 * ONE SALESMAN'S DAY, fetched on a click rather than carried on every row.
 *
 * The Attendance roll-call is already standing on a date, and the question
 * "do I believe what he sent me on Tuesday" is asked of one person at a time —
 * so the evidence for the row somebody pressed is fetched here and shown over
 * the list, instead of navigating to a nine-tab record and coming back.
 *
 * Eleven people's evidence rendered into the roll-call up front would be
 * eleven days of photographs serialised into a page to answer a question about
 * one of them, which is the mistake the customer record already carries three
 * paragraphs about.
 *
 * `dayEvidence` runs the narrowing itself — it answers null for anybody
 * outside this manager's patch, which covers both "no such person" and "not
 * yours" deliberately. The `sales` GRANT is asked FIRST and separately, for
 * the reason `canReadAttendanceSelfie` names: `managerScope` is vacuous for
 * anybody with no region row, so the narrowing alone would let a plain field
 * salesman read a colleague's day by id. This is the same gate the
 * `/sales/attendance` layout applies; the route has none of its own but a
 * signed-in session.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ evidence: null }, { status: 401 });

  const apps = await listUserApps(user.id);
  if (!apps.includes("sales")) return NextResponse.json({ evidence: null }, { status: 403 });

  const url = new URL(request.url);
  const salesman = url.searchParams.get("salesman");
  const day = url.searchParams.get("day") ?? "";
  /* Validated rather than trusted: it is spliced into a date cast downstream,
     and an unparseable one would throw where a refusal is the honest answer. */
  if (!salesman || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ evidence: null }, { status: 400 });
  }

  const evidence = await dayEvidence(salesman, day);
  return NextResponse.json({ evidence });
}
