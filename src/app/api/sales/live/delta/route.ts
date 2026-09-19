import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canOpenModule } from "@/lib/access";
import { liveDeltaFor, managerScope } from "@/lib/services/sales-service";

/**
 * THE SAME ANSWER, ASKED FOR RATHER THAN TOLD.
 *
 * `../stream` is the ordinary path and this is what happens when it cannot be
 * had. A corporate proxy that buffers, an antivirus that holds a response until
 * it has seen the end of it, a browser that has run out of connections to this
 * origin, an extension: every one of those produces a stream that opens
 * perfectly and delivers nothing, and a map that has silently stopped updating
 * is worse than one that never claimed to be live. So the client gives up on a
 * silent stream and asks here instead, on
 * `mbos.location.livePollSeconds` — and says on the screen which of the two it
 * is doing, because a screen that lies about how fresh it is is the thing this
 * whole change was meant to end.
 *
 * **It is the same function, not a second reading of the same question.**
 * `liveDeltaFor` is what the stream ticks on, so the fallback cannot drift into
 * answering something slightly different — which is how a fallback path comes
 * to be the one with the bug in it, discovered by whoever is least able to
 * report it.
 *
 * **Still a delta, and that is why this is not simply the old poll.** What
 * comes back is the fixes that have arrived since the cursor, not the day: even
 * at fifteen seconds it is a fraction of what one thirty-second
 * `router.refresh()` used to cost.
 *
 * Scope: the `sales` grant and the `sales.live` module are asked FIRST and
 * `managerScope` narrows behind them, exactly as in the stream beside it — see
 * that file for why the order matters and why the scope must never be resolved
 * anywhere but inside the request.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "signed out" }, { status: 401, ...NO_STORE });

  /* The `sales` GRANT and the `sales.live` module together, in that order —
     see `canOpenModule`. Asking `listUserModules` alone answers "every module"
     for somebody who holds none of the app. */
  if (!(await canOpenModule(user.id, "sales.live"))) {
    return NextResponse.json({ error: "not yours" }, { status: 403, ...NO_STORE });
  }

  const params = new URL(request.url).searchParams;
  const day = params.get("day") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: "no day" }, { status: 400, ...NO_STORE });
  }

  const since = Number(params.get("since"));
  const delta = await liveDeltaFor(await managerScope(), {
    day,
    sinceMs: Number.isFinite(since) && since > 0 ? since : null,
    withActivity: params.get("view") === "today",
    /*
     * A POLL ALWAYS CARRIES THE TEAM READ, and the stream deliberately does
     * not.
     *
     * The stream can afford to separate them because it is still there in six
     * seconds — the pin moves on the cheap tick and the row catches up on a
     * slower one. A poll has no such second chance: the client asks on the
     * fallback cadence and whatever does not come back is not coming back until
     * the next ask, so splitting the two here would mean the battery, the
     * check-out and the device state arrived on some asks and not others, with
     * nothing on the screen saying which kind of ask this was. The fallback
     * cadence is slower than the push cadence precisely so it can afford this.
     */
    withTeam: true,
  });

  return NextResponse.json(delta, NO_STORE);
}
