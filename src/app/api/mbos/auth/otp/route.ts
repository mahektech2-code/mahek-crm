import { NextResponse } from "next/server";
import { findAccount, otpAvailability, sendOtp } from "@/lib/services/otp-service";

/* ---------------------------------------------------------------------------
 * The handset's "sign in with a WhatsApp code", step one.
 *
 * GET says whether codes are offered at all — the sign-in screen asks before
 * it draws the option, so a handset never offers a button that cannot work.
 * POST { mobile } sends a code to the work number on that account. The code
 * is then posted to /api/mbos/auth/login as `otp` in place of `password`, and
 * every other sign-in check (active account, the field app, device binding)
 * applies exactly as it does to a password.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function GET() {
  const a = await otpAvailability();
  return NextResponse.json({ available: a.available });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "The request was not readable JSON." }, { status: 400 });
  }
  const mobile = typeof body.mobile === "string" ? body.mobile.trim() : "";
  if (!mobile) return NextResponse.json({ ok: false, error: "Enter your work number." }, { status: 400 });

  const user = await findAccount(mobile);
  if (!user || !user.active) {
    return NextResponse.json(
      { ok: false, error: `No open MahekOne account uses ${mobile}. Check the number, or ask your manager.` },
      { status: 404 },
    );
  }
  const sent = await sendOtp(user.id, "login");
  if (!sent.ok) {
    return NextResponse.json({ ok: false, error: sent.error, retryInSeconds: sent.retryInSeconds ?? null },
      { status: sent.retryInSeconds ? 429 : 400 },
    );
  }
  return NextResponse.json({ ok: true, sentTo: sent.sentTo, expiresInMinutes: sent.expiresInMinutes });
}
