import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { mbosPositions } from "@/db/schema";
import { authenticate } from "@/lib/services/mbos-service";
import { getConfig } from "@/lib/config/store";

/* ---------------------------------------------------------------------------
 * The trail.
 *
 * **Its own endpoint rather than a sync entity type**, and deliberately.
 * `/sync` is dependency-ordered and retries for ever, because a visit that
 * never arrives is a call nobody has a record of. A position is the opposite
 * kind of thing: one of a hundred, worth nothing on its own, and one lost is a
 * slightly coarser line on a map. Putting them through the outbox would queue a
 * hundred rows a day in front of the visit behind them, on a 2G connection, for
 * no gain at all.
 *
 * **The setting is checked HERE as well as on the handset.** A feature turned
 * off in the office has to be off, not merely undrawn — the same rule the
 * microphone follows, and for the same reason: a hidden control is not a
 * disabled one, and an old build carries on doing whatever it was built to do.
 *
 * **Nothing is confirmed row by row.** The handset deletes what it sent once
 * this answers, so the answer says how many landed and nothing more. A
 * duplicate is dropped on the primary key rather than reported — the id was
 * minted on the device, so a retry writes the same rows.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

/** One batch is a few hours of a stalled handset catching up, not a day of them. */
const MAX_BATCH = 500;

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, code: auth.code, error: auth.error },
      { status: auth.status },
    );
  }

  const config = await getConfig();
  if (!config["mbos.location.trackWhileWorking"]) {
    /* Not an error. The handset has nothing to fix and nothing to retry — it
     * should stop taking fixes and drop what it holds, which is what `off`
     * tells it to do. A 4xx here would look like a fault and be retried. */
    return NextResponse.json({ ok: true, stored: 0, tracking: "off" });
  }

  let body: { positions?: unknown };
  try {
    body = (await request.json()) as { positions?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, code: "validation", error: "That was not readable JSON." },
      { status: 400 },
    );
  }

  const rows = Array.isArray(body.positions) ? body.positions : [];
  if (rows.length > MAX_BATCH) {
    return NextResponse.json(
      {
        ok: false,
        code: "validation",
        error: `A batch is at most ${MAX_BATCH} positions. Send the oldest first.`,
      },
      { status: 400 },
    );
  }

  const values = rows.flatMap((raw) => {
    const p = raw as Record<string, unknown>;
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    const at = Number(p.at);
    /* A fix with no coordinates is not a fix. Dropped rather than refused: one
     * bad row in a batch of two hundred must not cost the other hundred and
     * ninety-nine, and there is nobody to tell about it anyway. */
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(at)) return [];
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return [];

    return [
      {
        id: typeof p.id === "string" && p.id ? p.id : `mbos_pos_${randomUUID()}`,
        userId: auth.principal.user.id,
        at: new Date(at),
        lat,
        lng,
        accuracyM: Number.isFinite(Number(p.accuracyM)) ? Math.round(Number(p.accuracyM)) : null,
        deviceId: auth.principal.deviceId,
      },
    ];
  });

  if (values.length) {
    await db.insert(mbosPositions).values(values).onConflictDoNothing();
  }

  return NextResponse.json({
    ok: true,
    stored: values.length,
    dropped: rows.length - values.length,
  });
}
