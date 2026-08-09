import { NextResponse } from "next/server";
import { provisionUser } from "@/lib/services/provisioning-service";

/* ---------------------------------------------------------------------------
 * Correcting an account on a machine with no shell.
 *
 * The Admin Console's People section cannot do this — it renders a hardcoded
 * array and its access checkboxes never reach the database — and the grant
 * script needs a terminal a deployment does not have. So a live installation
 * had no way to give somebody an app or fix a name.
 *
 * Guarded by CRON_SECRET, like the sync route, and refuses outright without
 * one. It can only modify accounts that already exist: no creation, no
 * passwords, and every change written to the audit log.
 *
 *   ?user=vikram@mahek.in&name=Pritesh%20Doshi&email=pritesh@mahek.in
 *   ?user=pritesh@mahek.in&role=admin&apps=crm,orders,people,reports,hrms,admin
 *   ?user=pritesh@mahek.in&addApps=hrms
 *
 * `apps` replaces the whole set; `addApps` leaves the rest alone. Both report
 * what actually changed rather than what was asked for.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const list = (v: string | null) =>
  v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

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

  const p = new URL(request.url).searchParams;
  const user = p.get("user");
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Name the account with ?user= (email or work number)." },
      { status: 400 },
    );
  }

  const role = p.get("role");
  if (role && !["telecaller", "manager", "accounts", "admin"].includes(role)) {
    return NextResponse.json(
      { ok: false, error: `"${role}" is not a role.` },
      { status: 400 },
    );
  }

  try {
    const result = await provisionUser({
      user,
      name: p.get("name") ?? undefined,
      email: p.get("email") ?? undefined,
      role: (role as "telecaller" | "manager" | "accounts" | "admin") ?? undefined,
      apps: list(p.get("apps")),
      addApps: list(p.get("addApps")),
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
