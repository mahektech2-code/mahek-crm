import { NextResponse } from "next/server";
import { runJob, type JobName } from "@/lib/jobs";

/* ---------------------------------------------------------------------------
 * The order sheet's only trigger on a deployed machine.
 *
 * The three sync jobs were CLI-only, which is fine on a laptop and useless on
 * Vercel — there is no shell there, so nothing has ever imported an order into
 * production. This is what makes the schedule reachable.
 *
 * Which job runs is a query parameter rather than three routes, because they
 * are one job with three appetites and a caller reads better naming the mode
 * than the path:
 *
 *   ?mode=append      only past the highest row seen. Cheap, every few minutes.
 *   ?mode=reconcile   the whole tab, hash-compared. Catches edits and deletions.
 *   ?mode=payments    the Payment Status tab, always a full compare — a payment
 *                     row's whole purpose is to change in place long after it
 *                     was written, which an append run would never see.
 *   ?mode=taken       the Taken Order tab — orders as the team types them,
 *                     before dispatch. Always a full compare, for the payments
 *                     reason: a row's status changes in place long after it is
 *                     written, and that change is the whole signal. It ends by
 *                     rebuilding which customers are held from order calls.
 *   ?mode=parties     the customer master. Where the phone numbers come from.
 *   ?mode=project     turn what has landed into customers, orders and — only
 *                     when asked — bills. Takes &owner=, &leads=1, &bills=1,
 *                     and &reassign=1 to move customers that already exist.
 *   ?mode=nightly     rebuilds every derived value. Nothing else does: buying
 *                     cycles, the inactive watch, follow-up stages and slow
 *                     payers are caches, and on a deployment with no cron they
 *                     stay at whatever the last import left them — an empty
 *                     Inactive Watch reads as "nobody has gone quiet" when it
 *                     means "nothing has looked".
 *   ?mode=team        gives the back office team logins and hands each of them
 *                     the accounts the master says they work. Takes &password=
 *                     for the accounts it creates — never for existing ones.
 *
 * `reparse` is deliberately NOT reachable here. It re-reads stored rows after
 * somebody corrects a parsing rule, which is a decision a person makes with a
 * deploy, not something a schedule should do on its own.
 *
 * NOTHING SCHEDULES THIS. Vercel Cron is a paid feature and this account is on
 * the free plan, so there are no cron entries — the route exists and has to be
 * called: by hand, by a GitHub Action, or by any external scheduler holding the
 * secret. Left uncalled the sheet is read only when somebody asks, which is a
 * choice worth knowing about rather than a gap to discover from stale figures.
 *
 * It is not open. A caller sends `Authorization: Bearer $CRON_SECRET`, and
 * without a secret configured the route refuses rather than running — an
 * endpoint that pulls a company's order book into the database on request is
 * not a default anybody should get by forgetting a variable.
 * ------------------------------------------------------------------------- */

// A sheet read and a batch of writes: never cached, never prerendered.
export const dynamic = "force-dynamic";

/** A long reconcile is minutes of work, not the default ten seconds. */
export const maxDuration = 300;

const JOBS: Record<string, JobName> = {
  append: "sheet-append",
  reconcile: "sheet-reconcile",
  payments: "sheet-payments",
  taken: "taken-order-sync",
  parties: "party-sync",
  project: "project-sheet",
  team: "provision-team",
  // The derived values: buying cycles, the inactive watch, follow-up stages,
  // slow payers, bill statuses, today's queue snapshot.
  nightly: "nightly",
};

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

  const mode = new URL(request.url).searchParams.get("mode") ?? "append";
  const job = JOBS[mode];
  if (!job) {
    return NextResponse.json(
      { ok: false, error: `Unknown mode "${mode}". Use one of: ${Object.keys(JOBS).join(", ")}.` },
      { status: 400 },
    );
  }

  // Only the projection reads these, and only because both are decisions
  // somebody has to make rather than defaults worth inheriting: who the
  // imported customers answer to, and whether parties that have never ordered
  // become somebody's calling list.
  const params = new URL(request.url).searchParams;
  const options = {
    owner: params.get("owner") ?? undefined,
    leads: params.get("leads") === "1",
    bills: params.get("bills") === "1",
    reassign: params.get("reassign") === "1",
    password: params.get("password") ?? undefined,
  };

  try {
    const [result] = await runJob(job, undefined, options);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // The job row already carries the failure; this is what the cron log sees.
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
