import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mbosDevices } from "@/db/schema";
import { authenticate } from "@/lib/services/mbos-service";

/**
 * The handset telling MahekOne where to push to.
 *
 * Its own endpoint rather than folded into sign-in, because the token is not
 * known at login time — it is requested from Expo AFTER notification
 * permission is granted, a step later than the app opening — and Expo can
 * rotate a token without a new sign-in, so a device row has to accept this
 * on its own at any point in a session.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  let body: { pushToken?: unknown };
  try {
    body = (await request.json()) as { pushToken?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, code: "validation", error: "That was not readable JSON." },
      { status: 400 },
    );
  }

  const pushToken = typeof body.pushToken === "string" && body.pushToken ? body.pushToken : null;

  await db
    .update(mbosDevices)
    .set({ pushToken })
    .where(eq(mbosDevices.deviceId, auth.principal.deviceId));

  return NextResponse.json({ ok: true });
}

/**
 * A SIGNED-OUT PHONE LETTING GO OF ITS TOKEN — no session, by design.
 *
 * Sign-out clears the token with the session's own request, and with no signal
 * that request never went: the server went on pushing the last person's
 * decisions to a phone nobody was signed in to. The handset keeps the token
 * aside and sends it here the next time it opens signed out. Both the device
 * and the token must match, so knowing a device id is not enough to silence
 * somebody's phone; the answer is the same either way.
 */
export async function DELETE(request: Request) {
  let body: { deviceId?: unknown; pushToken?: unknown };
  try {
    body = (await request.json()) as { deviceId?: unknown; pushToken?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "validation", error: "That was not readable JSON." }, { status: 400 });
  }
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const pushToken = typeof body.pushToken === "string" ? body.pushToken : "";
  if (deviceId && pushToken) {
    await db
      .update(mbosDevices)
      .set({ pushToken: null })
      .where(and(eq(mbosDevices.deviceId, deviceId), eq(mbosDevices.pushToken, pushToken)));
  }
  return NextResponse.json({ ok: true });
}
