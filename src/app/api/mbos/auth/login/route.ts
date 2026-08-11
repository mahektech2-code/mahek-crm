import { NextResponse } from "next/server";
import { mbosLogin } from "@/lib/actions/mbos";

/* ---------------------------------------------------------------------------
 * MBOS sign-in — PROTOCOL.md §4.
 *
 * Five checks, in order, each with its own sentence, because they send the
 * person to five different places: retype the number, retype the password,
 * ring your manager to reopen the account, ring your manager for the app, try
 * again in a moment. A single "sign-in failed" sends them to none of them.
 *
 * The handler does no work of its own. It parses, calls the action, and maps
 * the outcome to a status code — the rules live in `lib/actions/mbos.ts` and
 * `lib/services/mbos-service.ts` where they can be tested.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "The sign-in request was not readable JSON." },
      { status: 400 },
    );
  }

  const mobile = typeof body.mobile === "string" ? body.mobile : "";
  if (!mobile) {
    return NextResponse.json(
      { ok: false, step: "validation", error: "Enter your work number or your email." },
      { status: 400 },
    );
  }

  const result = await mbosLogin({
    mobile,
    password: typeof body.password === "string" ? body.password : undefined,
    otp: typeof body.otp === "string" ? body.otp : undefined,
    deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
    deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : undefined,
    platform: typeof body.platform === "string" ? body.platform : undefined,
    appVersion: typeof body.appVersion === "string" ? body.appVersion : undefined,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, step: result.step, error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    accessToken: result.accessToken,
    accessExpiresAt: result.accessExpiresAt,
    refreshToken: result.refreshToken,
    refreshExpiresAt: result.refreshExpiresAt,
    bootstrap: result.bootstrap,
  });
}
