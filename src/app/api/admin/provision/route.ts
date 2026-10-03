import { NextResponse } from "next/server";
import { provisionUser } from "@/lib/services/provisioning-service";

/* ---------------------------------------------------------------------------
 * Correcting an account on a machine with no shell.
 *
 * The Access screen is how a person grants an app, and the grant script needs
 * a terminal a deployment does not have. This is for what neither reaches: an
 * installation with nobody able to sign into the console, or a script fixing
 * an account from outside.
 *
 * Guarded by CRON_SECRET, like the sync route, and refuses outright without
 * one. It can only modify accounts that already exist: no creation, no
 * passwords, no account level of its own (that is derived from the grants),
 * and every change written to the audit log.
 *
 * POST ONLY, with a JSON body. It answered GET, with everything in the query
 * string — so a change to who can open payroll was a URL, and a URL is
 * something browsers prefetch, proxies log in full and people paste into
 * chat. Nothing in `deploy/` or `scripts/` called it, so there was no caller
 * to keep working; GET now answers 405 and says how to ask instead.
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *        -H "Content-Type: application/json" \
 *        -d '{"user":"pritesh@mahek.in","addApps":["hrms:manager"]}' \
 *        https://one.mahekindia.com/api/admin/provision
 *
 *   {"user":"vikram@mahek.in","name":"Pritesh Doshi","email":"pritesh@mahek.in"}
 *   {"user":"pritesh@mahek.in","apps":["crm:manager","accounts","admin:admin"]}
 *   {"user":"pritesh@mahek.in","addApps":["hrms"],"level":"manager"}
 *
 * `apps` replaces the whole set; `addApps` leaves the rest alone. An entry is
 * `app` or `app:level`, and `level` is what an entry without one is granted
 * at — associate when that is absent too. Both report what actually changed
 * rather than what was asked for.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const LEVELS = ["associate", "manager", "admin"] as const;
type Level = (typeof LEVELS)[number];

function list(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      error:
        'This endpoint changes access, so it takes POST with a JSON body: {"user": "…", "apps" | "addApps": ["app" or "app:level"], "level"?, "name"?, "email"?}.',
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(request: Request) {
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

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Send a JSON object as the body." }, { status: 400 });
  }

  const user = typeof body.user === "string" ? body.user.trim() : "";
  if (!user) {
    return NextResponse.json(
      { ok: false, error: 'Name the account with "user" (email or work number).' },
      { status: 400 },
    );
  }

  if ("role" in body) {
    /* Said rather than ignored: a caller still sending the old field expects
       it to have done something, and silently dropping it would report
       success for a change that never happened. */
    return NextResponse.json(
      {
        ok: false,
        error:
          '"role" is gone — the account level is derived from the apps. Grant a level per app ("crm:manager"), or send "level" for the apps named.',
      },
      { status: 400 },
    );
  }

  const level = body.level;
  if (level != null && !LEVELS.includes(level as Level)) {
    return NextResponse.json({ ok: false, error: `"${String(level)}" is not a level.` }, { status: 400 });
  }

  try {
    const result = await provisionUser({
      user,
      name: typeof body.name === "string" ? body.name : undefined,
      email: typeof body.email === "string" ? body.email : undefined,
      level: (level as Level | undefined) ?? undefined,
      apps: list(body.apps),
      addApps: list(body.addApps),
    });
    return NextResponse.json({
      ok: true,
      ...result,
      detail: result.changed.length ? result.changed.join("; ") : "Nothing to change.",
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
