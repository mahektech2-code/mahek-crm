import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mbosDevices } from "@/db/schema";
import { authenticate } from "@/lib/services/mbos-service";
import { readDeviceState } from "@/lib/mbos/device-state";

/**
 * The handset telling MahekOne which kind of tracking it is actually
 * running — not known at sign-in, and not knowable from the server side at
 * all, since the OS's answer to the background permission prompt never
 * reaches a request the handset does not choose to make. Its own endpoint
 * for the same reason `push-token` has one: the fact is discovered mid
 * session, in `trail.ts`'s `start()`, and has to be able to update the
 * device row on its own.
 *
 * IT NOW TAKES MORE THAN A BOOLEAN, and the old shape still works.
 *
 * `backgroundGranted` alone could not tell "Allow only while using the app"
 * from "refused outright", nor either of those from location being switched
 * off on the phone — and those are three different conversations to have with
 * a salesman. The richer fields are all OPTIONAL, because an APK cannot be
 * recalled: every handset in the field today posts the boolean and nothing
 * else, and each of those is a real report that must go on being accepted.
 *
 * The endpoint keeps its name. It is what the handsets in circulation call,
 * and renaming a URL that shipped inside an APK is how the office stops
 * hearing from the phones it can no longer change.
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
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

  /*
   * The boolean is still written, and it is still the one the older handsets
   * are answering. `readDeviceState` returns only the fields that actually
   * arrived, so a build that sends nothing but the boolean cannot blank the
   * richer columns a later build has already filled in — a partial report is
   * a partial update, never a reset.
   */
  await db
    .update(mbosDevices)
    .set({
      backgroundLocationGranted: body.backgroundGranted,
      ...readDeviceState(body),
    })
    .where(eq(mbosDevices.deviceId, auth.principal.deviceId));

  return NextResponse.json({ ok: true });
}
