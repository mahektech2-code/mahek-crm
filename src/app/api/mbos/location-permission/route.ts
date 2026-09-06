import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mbosDevices } from "@/db/schema";
import { authenticate } from "@/lib/services/mbos-service";

/**
 * The handset telling MahekOne which kind of tracking it is actually
 * running — not known at sign-in, and not knowable from the server side at
 * all, since the OS's answer to the background permission prompt never
 * reaches a request the handset does not choose to make. Its own endpoint
 * for the same reason `push-token` has one: the fact is discovered mid
 * session, in `trail.ts`'s `start()`, and has to be able to update the
 * device row on its own.
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

  let body: { backgroundGranted?: unknown };
  try {
    body = (await request.json()) as { backgroundGranted?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, code: "validation", error: "That was not readable JSON." },
      { status: 400 },
    );
  }

  if (typeof body.backgroundGranted !== "boolean") {
    return NextResponse.json(
      { ok: false, code: "validation", error: "backgroundGranted must be true or false." },
      { status: 400 },
    );
  }

  await db
    .update(mbosDevices)
    .set({ backgroundLocationGranted: body.backgroundGranted })
    .where(eq(mbosDevices.deviceId, auth.principal.deviceId));

  return NextResponse.json({ ok: true });
}
