/**
 * WHAT A LIVE MAP DOES WITH WHAT IT HAS JUST BEEN TOLD.
 *
 * The Live map used to be redrawn by re-running its whole Server Component
 * every thirty seconds. That answered "what does the day look like" over and
 * over — the team read, both trail reads, the activity read and a full
 * serialisation of all of it, for every open tab, whether or not one fix had
 * arrived. It is told now instead: a connection stays open and the server
 * pushes the rows that arrived since it last spoke.
 *
 * Which moves the whole problem here. A screen that is HANDED the answer needs
 * no arithmetic; a screen that is handed a DIFFERENCE has to fold it into what
 * it already holds, and every way of getting that wrong looks like data rather
 * than like a bug — a doubled point, a line that jumps back across a city, a
 * pin that walks backwards in time. So the folding is in an engine, pure and
 * tested, rather than inside a `useEffect` where it can only be exercised by a
 * manager watching a real salesman move.
 *
 * Pure like every other engine here: no I/O, no clock, no DOM. It is handed
 * the frame it has and the delta that arrived, and returns the new frame.
 */

/* ------------------------------------------------------------------- types */

/**
 * One point on a trail, structurally rather than by importing `TrackPoint`.
 *
 * Identical to it on purpose — this file is what folds new points into the map
 * `TrackPoint`s are held in, and the two have to be the same shape for that to
 * mean anything. It is spelled out here so the engine stays free of
 * `server-only`, which is what `TrackPoint` is declared beside.
 */
export type TrailPoint = {
  lat: number;
  lng: number;
  /** The HANDSET's clock. A trail is a shape, and a shape needs its own order. */
  at: Date;
  accuracyM: number | null;
  /** Set on the points that are a visit rather than a plain fix. */
  place: string | null;
};

/** One fix as the wire carries it: a trail point, and whose it is. */
export type LivePosition = TrailPoint & { salesmanId: string };

/**
 * The part of a team row a fix is allowed to move, structurally rather than by
 * importing `LastKnown`.
 *
 * Generic so the tests can drive it with four fields instead of the thirty the
 * real row carries — and so this file stays free of `server-only`, which is
 * what `LastKnown` is declared beside.
 */
export type PinnedRow = {
  salesmanId: string;
  lat: number | null;
  lng: number | null;
  seenAt: Date | string | null;
  trailSeenAt: Date | string | null;
  place: string | null;
};

/** Enough of an activity mark to keep one copy of it. */
export type MarkedActivity = {
  entityType: string;
  entityId: string;
};

/* ------------------------------------------------------------------ helpers */

/**
 * A timestamp off the wire is a STRING, whatever the type beside it says.
 *
 * `lastKnownPositions` and the trail reads are raw `db.execute` calls, and
 * drizzle disables postgres.js's own timestamp parsing on the shared client —
 * so every date these rows carry is already a string before JSON is anywhere
 * near it, and is a string again after. Reading `.getTime()` on one is the
 * failure, and it is silent: `undefined` compares false against everything, so
 * a pin simply stops moving.
 */
function msOf(at: Date | string | null | undefined): number | null {
  if (at == null) return null;
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * THE SAME KEY THE DATABASE ITSELF DEDUPLICATES ON.
 *
 * `mbos_positions_fix_key` is `(user_id, at, lat, lng)`, because a position IS
 * its reading and Android hands the same batch of deferred fixes over again
 * whenever the background task did not complete — see the index's own note in
 * `schema.ts`. The browser needs exactly the same rule for exactly the same
 * reason one level up: a delta whose window overlaps the last one by a
 * millisecond, or a reconnect that replays from a cursor already spent, must
 * not put a second dot on the map. Keyed on anything else — an id, an arrival
 * order — and the two ends would deduplicate differently, which is the shape of
 * bug nobody finds by looking at either end.
 */
function fixKey(p: { at: Date; lat: number; lng: number }): string {
  return `${p.at.getTime()}|${p.lat}|${p.lng}`;
}

/* ------------------------------------------------------------------- track */

/**
 * New fixes folded into a trail already on screen.
 *
 * **Merged in TIME order, never appended.** The cursor this delta was asked
 * with is an ARRIVAL time and not a reading time, deliberately — a handset
 * with no signal queues its morning and uploads it at lunch, and a cursor on
 * the reading would step straight over every one of those and never come back
 * for them. The consequence is that a delta legitimately carries fixes OLDER
 * than the newest point already drawn, and appending them draws a line that
 * runs to the far side of the city and back. The trail is a shape, and a shape
 * needs its own order.
 *
 * It is a sort of the joined list rather than an insertion walk because the
 * common case is already sorted — a run of new fixes after everything held —
 * and a sort that is handed sorted input is cheap, whereas an insertion walk
 * written by hand is one more thing to get wrong for no gain at this size.
 */
export function mergeTrack(held: TrailPoint[], arrived: TrailPoint[]): TrailPoint[] {
  if (!arrived.length) return held;
  const seen = new Set(held.map(fixKey));
  const fresh = arrived.filter((p) => !seen.has(fixKey(p)));
  if (!fresh.length) return held;
  const all = held.concat(fresh);
  all.sort((a, b) => a.at.getTime() - b.at.getTime());
  return all;
}

/**
 * The work marked along the day, with one copy of each act.
 *
 * `mbos_activity_locations_entity_key` is `(entity_type, entity_id)` — one
 * location per activity, so a retried sync writes the same row rather than a
 * second one. The same key is what keeps a redelivered delta from drawing the
 * same order twice here, and a mark that ARRIVED AGAIN wins: the row can be
 * rewritten by a later sync carrying a better fix, and the newer copy is the
 * one the server just sent.
 */
export function mergeActivity<A extends MarkedActivity>(held: A[], arrived: A[]): A[] {
  if (!arrived.length) return held;
  const byKey = new Map(held.map((a) => [`${a.entityType}:${a.entityId}`, a] as const));
  for (const a of arrived) byKey.set(`${a.entityType}:${a.entityId}`, a);
  return [...byKey.values()];
}

/* -------------------------------------------------------------------- pins */

/**
 * THE PIN MOVES ON A FIX; THE REST OF THE ROW WAITS FOR THE FULL READ.
 *
 * `lastKnownPositions` is the expensive half of this screen — the check-in, the
 * battery, the permission, the device, the place name, for every salesman — and
 * running it at the push cadence would make the cheap update the costly one.
 * But the only part of it a new fix can change is where the man is, and that is
 * arithmetic the browser can do for itself from the fixes it was just handed.
 *
 * **It is the same rule the service states, not a second one.** `seenAt` is the
 * newest of three sources — the trail, the check-in and each visit — so a trail
 * fix may only move the pin where it is NEWER than what the row already says. A
 * salesman who checked into a shop at 11:04 and whose phone then uploads a
 * queued 10:40 fix must stay at the shop; overwriting unconditionally would
 * walk him backwards down the road he came up, on a screen whose whole subject
 * is where he is now.
 *
 * `place` goes to null with a trail fix and that is correct rather than a loss:
 * a point between two shops has no place name, and carrying the last shop's
 * name forward would put a man inside a building he left twenty minutes ago.
 * `trailSeenAt` moves on ANY trail fix regardless of the pin, because it
 * answers a different question — whether the trail is producing anything at all
 * — and a queued fix arriving is evidence that it is.
 */
export function movePins<R extends PinnedRow>(rows: R[], arrived: LivePosition[]): R[] {
  if (!arrived.length) return rows;

  /* The newest fix per salesman is all that can matter to a pin; the rest of
     the batch is trail, and was folded in by `mergeTrack`. */
  const newest = new Map<string, LivePosition>();
  for (const p of arrived) {
    const held = newest.get(p.salesmanId);
    if (!held || p.at.getTime() > held.at.getTime()) newest.set(p.salesmanId, p);
  }

  let moved = false;
  const next = rows.map((row) => {
    const fix = newest.get(row.salesmanId);
    if (!fix) return row;
    const fixMs = fix.at.getTime();

    const trailMs = msOf(row.trailSeenAt);
    const trailSeenAt = trailMs === null || fixMs > trailMs ? fix.at : row.trailSeenAt;

    const seenMs = msOf(row.seenAt);
    if (seenMs !== null && fixMs <= seenMs) {
      if (trailSeenAt === row.trailSeenAt) return row;
      moved = true;
      return { ...row, trailSeenAt };
    }

    moved = true;
    return {
      ...row,
      lat: fix.lat,
      lng: fix.lng,
      seenAt: fix.at,
      trailSeenAt,
      /* A visit's fix names the shop; a plain trail fix names nothing, and
         "On the road" is what the team list renders from a null. */
      place: fix.place,
    };
  });

  /* Identity is the signal the map redraws on — see `street-map.tsx`. Handing
     back a fresh array when nothing moved would repaint every marker on a tick
     that brought nothing worth repainting. */
  return moved ? next : rows;
}

/* ------------------------------------------------------------------- frame */

/** Everything the map is currently drawing, and how far it has been told. */
export type LiveFrame<R extends PinnedRow, A extends MarkedActivity> = {
  rows: R[];
  tracks: Map<string, TrailPoint[]>;
  activity: A[];
  /**
   * The newest ARRIVAL the server has answered for, in ms. It is the server's
   * own clock and is never read from a browser's: the two disagree by minutes
   * on real machines, and a cursor a few minutes fast skips every fix that
   * lands in the gap.
   */
  cursorMs: number;
};

/** What the server pushes. `rows` is null on the ticks that carry no team read. */
export type LiveDelta<R extends PinnedRow, A extends MarkedActivity> = {
  cursorMs: number;
  rows: R[] | null;
  positions: LivePosition[];
  activity: A[];
};

/**
 * The frame the map should draw next.
 *
 * **A cursor never goes backwards.** Deltas can arrive out of order — a
 * reconnect answers from the cursor the browser last stored while a tick from
 * the old connection is still in flight — and taking the newer answer's cursor
 * blindly would step the window back over rows already folded in. They would
 * simply arrive twice, which the two dedup keys above already make harmless,
 * so this is belt rather than braces; it is here because the alternative is a
 * cursor that oscillates and a window that keeps re-asking for the same
 * thousand rows on a box that has one core.
 */
export function mergeLiveDelta<R extends PinnedRow, A extends MarkedActivity>(
  frame: LiveFrame<R, A>,
  delta: LiveDelta<R, A>,
): LiveFrame<R, A> {
  const cursorMs = Math.max(frame.cursorMs, delta.cursorMs);

  /* A full team read replaces the rows outright — it is the better answer to
     every question on them, including where the man is. The fixes in the same
     delta are then folded over it, because a read taken a moment before the
     last fix landed would otherwise put the pin back. */
  const base = delta.rows ?? frame.rows;
  const rows = movePins(base, delta.positions);

  let tracks = frame.tracks;
  if (delta.positions.length) {
    const byPerson = new Map<string, LivePosition[]>();
    for (const p of delta.positions) {
      const list = byPerson.get(p.salesmanId);
      if (list) list.push(p);
      else byPerson.set(p.salesmanId, [p]);
    }
    /* A new Map only where something arrived: the map component keys its
       redraw on what it is handed, and a fresh Map every tick would be a
       redraw every tick whether or not the day changed. */
    tracks = new Map(frame.tracks);
    for (const [id, arrived] of byPerson) {
      tracks.set(id, mergeTrack(tracks.get(id) ?? [], arrived));
    }
  }

  return {
    cursorMs,
    rows,
    tracks,
    activity: mergeActivity(frame.activity, delta.activity),
  };
}
