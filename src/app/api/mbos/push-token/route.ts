import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
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
