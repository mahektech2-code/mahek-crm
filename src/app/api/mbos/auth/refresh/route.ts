import { NextResponse } from "next/server";
import { mbosRefresh } from "@/lib/actions/mbos";
import { bearerFrom } from "@/lib/mbos/token";

/* ---------------------------------------------------------------------------
 * Both tokens rotate — PROTOCOL.md §4.
 *
 * The refresh token may arrive in the body or as the bearer credential: a
 * background sync worker holds it in SecureStore and has no particular reason
 * to prefer one, and refusing the other would be a sign-out for a shape
 * detail.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let token = bearerFrom(request);
  if (!token) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      if (typeof body.refreshToken === "string") token = body.refreshToken;
    } catch {
      // No body is fine; the missing-token answer below covers it.
    }
  }

  if (!token) {
    return NextResponse.json(
      { ok: false, code: "malformed", error: "No refresh token was sent. Sign in again." },
      { status: 401 },
    );
  }

  const result = await mbosRefresh(token);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: result.code, error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    accessToken: result.accessToken,
    accessExpiresAt: result.accessExpiresAt,
    refreshToken: result.refreshToken,
    refreshExpiresAt: result.refreshExpiresAt,
  });
}
