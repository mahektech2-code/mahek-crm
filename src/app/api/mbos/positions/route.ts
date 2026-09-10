import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { mbosAttendanceDays, mbosDevices, mbosPositions } from "@/db/schema";
import { authenticate } from "@/lib/services/mbos-service";
import { getConfig } from "@/lib/config/store";
import { readDeviceState } from "@/lib/mbos/device-state";

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
 * **A fix is checked against the SESSION IT BELONGS TO, not against today.**
 * AGENTS.md says tracking "runs between the check-in and the check-out and not
 * one second either side", and this is where that is enforced — but it used to
 * be enforced by asking whether the sender is checked in RIGHT NOW, which is a
 * different question and gave the wrong answer twice over. A batch is a queue
 * catching up: its fixes were taken hours or days before they arrive, so the
 * day to judge them against is the day they were TAKEN. Worse, any closed day
 * refused the whole batch — and `markMissedCheckouts` closes a forgotten day at
 * the last position it can see, so a handset that lost its trail early had its
 * day closed early and then had every later fix refused BECAUSE the day was
 * closed. The privacy rule is unchanged and now actually holds for fixes taken
 * outside a session; what changes is that a fix taken inside one is kept
 * however late it arrives.
 *
 * **A batch with no session to file it against is KEPT, not dropped.** The
 * handset deletes what it sends on any `ok`, so answering "no" to a batch whose
 * check-in is still sitting in the outbox would silently destroy a morning to
 * win a race by thirty seconds. `no-session-yet` is the one answer that tells
 * it to hold on to them.
 *
 * **Nothing is confirmed row by row.** The handset deletes what it sent once
 * this answers, so the answer says how many landed and nothing more. A
 * duplicate is dropped on the unique index rather than reported — the id is
 * derived from the reading, so a redelivery writes the same row, and
 * `mbos_positions_fix_key` catches even a row whose id was minted before that
 * was true.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

/** One batch is a few hours of a stalled handset catching up, not a day of them. */
const MAX_BATCH = 500;

/**
 * How far outside a session a fix may fall and still belong to it.
 *
 * The check-in writes its own fix and its own timestamp from the same clock,
 * milliseconds apart but in an order nobody controls, so a strict comparison
 * throws away the first point of the day about half the time. Two minutes is
 * wide enough to cover that and the ordinary drift between a phone that has
 * been offline and a server that has not; it is nowhere near wide enough to be
 * the thing the rule exists to prevent, which is a track that carries on into
 * somebody's evening.
 */
const EDGE_GRACE_MS = 2 * 60_000;

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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
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

  if (!values.length) {
    return NextResponse.json({ ok: true, stored: 0, dropped: rows.length });
  }

  /* The days any of these fixes could belong to. Read from the fixes
     themselves rather than from the clock, because a batch is a backlog. */
  const times = values.map((v) => v.at.getTime());
  const oldest = new Date(Math.min(...times) - EDGE_GRACE_MS);
  const newest = new Date(Math.max(...times) + EDGE_GRACE_MS);

  const sessions = await db
    .select({ checkInAt: mbosAttendanceDays.checkInAt, checkOutAt: mbosAttendanceDays.checkOutAt })
    .from(mbosAttendanceDays)
    .where(
      and(
        eq(mbosAttendanceDays.userId, auth.principal.user.id),
        isNotNull(mbosAttendanceDays.checkInAt),
        lte(mbosAttendanceDays.checkInAt, newest),
        or(isNull(mbosAttendanceDays.checkOutAt), gte(mbosAttendanceDays.checkOutAt, oldest)),
      ),
    );

  if (!sessions.length) {
    /* Also not an error. The check-in these belong to has almost certainly not
     * synced yet — the outbox goes up before the trail does, but a failed push
     * puts them out of order. The handset holds on to them. */
    return NextResponse.json({ ok: true, stored: 0, tracking: "no-session-yet" });
  }

  const windows = sessions.map((s) => ({
    from: s.checkInAt!.getTime() - EDGE_GRACE_MS,
    /* An open day runs to now, which is to say it has no end yet. */
    to: s.checkOutAt ? s.checkOutAt.getTime() + EDGE_GRACE_MS : Number.POSITIVE_INFINITY,
  }));

  const inside = values.filter((v) => {
    const t = v.at.getTime();
    return windows.some((w) => t >= w.from && t <= w.to);
  });

  if (inside.length) {
    await db.insert(mbosPositions).values(inside).onConflictDoNothing();
  }

  /*
   * WHAT THE PHONE IS ITSELF DOING, on the one channel already open.
   *
   * A battery reading needs no request of its own: this batch runs every few
   * minutes while a day is open, is already authenticated and already names
   * the device. A second endpoint polling for battery would spend the battery
   * to report it.
   *
   * IT IS RECORDED ONLY INSIDE A WORKING DAY, and the placement is the whole
   * of that rule — everything above has already established that these fixes
   * belong to a session that exists. `mbos.location.trackWhileWorking` off
   * returned long before the body was read, and a batch with no session to
   * file it against returned above. A handset that carried on reporting its
   * battery after check-out would be a beacon on somebody's evening, which is
   * the thing the trail itself is forbidden from being.
   *
   * `lastSeenAt` moves with it. It was written at sign-in and nowhere else,
   * so four screens calling it "last synced" were in fact showing the last
   * time somebody typed their password — a handset syncing perfectly for a
   * week read as untouched since Monday. A position batch IS a sync, so this
   * is the column finally meaning what those screens already say it does.
   */
  const state = readDeviceState(body);
  await db
    .update(mbosDevices)
    .set({ ...state, lastSeenAt: new Date() })
    .where(eq(mbosDevices.deviceId, auth.principal.deviceId));

  return NextResponse.json({
    ok: true,
    stored: inside.length,
    dropped: rows.length - inside.length,
  });
}
