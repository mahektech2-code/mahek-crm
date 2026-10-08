import { NextResponse } from "next/server";
import { canOpen } from "@/lib/access";
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
  if (!mobile) return NextResponse.json({ ok: false, error: "Enter your mobile number." }, { status: 400 });

  const user = await findAccount(mobile);
  /*
   * ONLY TO SOMEBODY THE HANDSET WOULD LET IN.
   *
   * Login refuses an account without the `field` grant, but by then the code
   * had already gone out — so this endpoint would message the WhatsApp of any
   * employee whose number somebody typed, a telecaller or the founder, with a
   * sign-in code for an app they do not hold. That is a nuisance on its own and
   * a phishing pretext at its worst ("I sent you a code by mistake, read it
   * back to me"). So the grant is asked BEFORE anything is sent.
   *
   * And the answer for "no grant" is the answer for "no account", word for
   * word and status for status: a different reply would turn this form into a
   * way to find out which numbers belong to staff who hold the handset.
   */
  if (!user || !user.active || !(await canOpen(user.id, "field"))) {
    return NextResponse.json(
      { ok: false, error: `No open MahekOne account uses ${mobile}. Check the number, or ask your manager.` },
      { status: 404 },
    );
  }
  const sent = await sendOtp(user.id, "login", { surface: "handset", requestedWith: mobile });
  if (!sent.ok) {
    return NextResponse.json({ ok: false, error: sent.error, retryInSeconds: sent.retryInSeconds ?? null },
      { status: sent.retryInSeconds ? 429 : 400 },
    );
  }
  return NextResponse.json({ ok: true, sentTo: sent.sentTo, expiresInMinutes: sent.expiresInMinutes });
}
