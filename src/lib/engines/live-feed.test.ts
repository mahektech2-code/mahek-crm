import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeActivity,
  mergeLiveDelta,
  mergeTrack,
  movePins,
  type LiveFrame,
  type LivePosition,
  type PinnedRow,
} from "./live-feed";

/* ---------------------------------------------------------------- fixtures */

const DAY = "2026-09-19T";

function fix(time: string, lat: number, lng: number, salesmanId = "s1"): LivePosition {
  return { salesmanId, lat, lng, at: new Date(`${DAY}${time}+05:30`), accuracyM: 10, place: null };
}

function row(over: Partial<PinnedRow> = {}): PinnedRow {
  return {
    salesmanId: "s1",
    lat: 21.1,
    lng: 79.1,
    seenAt: `${DAY}10:00:00+05:30`,
    trailSeenAt: `${DAY}10:00:00+05:30`,
    place: null,
    ...over,
  };
}

function mark(entityId: string, lat = 0) {
  return { entityType: "order", entityId, lat };
}

/* ------------------------------------------------------------------- track */

test("a fix already drawn is not drawn again", () => {
  const held = [fix("10:00:00", 21.1, 79.1), fix("10:00:06", 21.2, 79.2)];
  /* The same reading arriving twice is the ordinary case, not a rare one:
     Android redelivers a batch of deferred fixes whenever the background task
     did not complete, and a reconnect replays from a cursor already spent. */
  const merged = mergeTrack(held, [fix("10:00:06", 21.2, 79.2), fix("10:00:12", 21.3, 79.3)]);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((p) => p.lat),
    [21.1, 21.2, 21.3],
  );
});

test("a fix that arrives late is put back where it was taken", () => {
  /* A handset with no signal queues its morning and uploads it at lunch. The
     cursor is an arrival time, so those fixes legitimately arrive after newer
     ones — appended, they draw a line to the far side of the city and back. */
  const held = [fix("10:00:00", 21.1, 79.1), fix("11:00:00", 21.9, 79.9)];
  const merged = mergeTrack(held, [fix("10:30:00", 21.5, 79.5)]);
  assert.deepEqual(
    merged.map((p) => p.lat),
    [21.1, 21.5, 21.9],
  );
});

test("nothing new leaves the trail's identity alone", () => {
  const held = [fix("10:00:00", 21.1, 79.1)];
  assert.equal(mergeTrack(held, []), held);
  assert.equal(mergeTrack(held, [fix("10:00:00", 21.1, 79.1)]), held);
});

/* ---------------------------------------------------------------- activity */

test("one act is one mark, and the newer copy wins", () => {
  const held = [mark("o1", 1), mark("o2")];
  const merged = mergeActivity(held, [mark("o1", 2), mark("o3")]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((m) => m.entityId === "o1")?.lat, 2);
});

/* -------------------------------------------------------------------- pins */

test("a newer fix moves the pin and clears the place name", () => {
  const rows = [row({ place: "Sadar Paints" })];
  const moved = movePins(rows, [fix("10:05:00", 21.5, 79.5)]);
  assert.equal(moved[0].lat, 21.5);
  assert.equal(moved[0].place, null);
  assert.equal(new Date(moved[0].seenAt!).toISOString(), new Date(`${DAY}10:05:00+05:30`).toISOString());
});

test("A QUEUED FIX NEVER WALKS SOMEBODY BACKWARDS", () => {
  /* He checked into a shop at 11:00 and his phone then uploaded a 10:40 fix
     from the road. `seenAt` is the newest of three sources, so the shop wins —
     the alternative is a pin walking back down the road he came up, on the one
     screen whose subject is where he is now. */
  const rows = [row({ seenAt: `${DAY}11:00:00+05:30`, lat: 22, lng: 80, place: "Sadar Paints" })];
  const moved = movePins(rows, [fix("10:40:00", 21.5, 79.5)]);
  assert.equal(moved[0].lat, 22);
  assert.equal(moved[0].place, "Sadar Paints");
  /* The trail still moved, though: that answers a different question — whether
     the trail is producing anything at all — and a queued fix is evidence. */
  assert.equal(
    new Date(moved[0].trailSeenAt!).toISOString(),
    new Date(`${DAY}10:40:00+05:30`).toISOString(),
  );
});

test("a fix for somebody else moves nobody", () => {
  const rows = [row(), row({ salesmanId: "s2", lat: 30, lng: 70 })];
  const moved = movePins(rows, [fix("10:05:00", 21.5, 79.5, "s2")]);
  assert.equal(moved[0].lat, 21.1);
  assert.equal(moved[1].lat, 21.5);
});

test("a tick that changed nothing hands back the same array", () => {
  /* Identity is what the map redraws on. A fresh array every tick is every
     marker repainted on a tick that brought nothing. */
  const rows = [row()];
  assert.equal(movePins(rows, []), rows);
  assert.equal(movePins(rows, [fix("09:00:00", 1, 1)]), rows);
});

/* ------------------------------------------------------------------- frame */

function frame(): LiveFrame<PinnedRow, ReturnType<typeof mark>> {
  return {
    rows: [row()],
    tracks: new Map([["s1", [fix("10:00:00", 21.1, 79.1)]]]),
    activity: [mark("o1")],
    cursorMs: 1000,
  };
}

test("a delta folds into the frame it arrived at", () => {
  const next = mergeLiveDelta(frame(), {
    cursorMs: 2000,
    rows: null,
    positions: [fix("10:00:06", 21.2, 79.2)],
    activity: [mark("o2")],
  });
  assert.equal(next.cursorMs, 2000);
  assert.equal(next.tracks.get("s1")!.length, 2);
  assert.equal(next.activity.length, 2);
  assert.equal(next.rows[0].lat, 21.2);
});

test("a cursor never goes backwards", () => {
  /* A reconnect answers from the cursor the browser stored while a tick from
     the old connection is still in flight. */
  const next = mergeLiveDelta(frame(), { cursorMs: 500, rows: null, positions: [], activity: [] });
  assert.equal(next.cursorMs, 1000);
});

test("a full team read replaces the rows, and the same delta's fixes still win", () => {
  /* The heavy read is taken a moment before the tick is written, so a fix that
     landed in between would otherwise put the pin back where it was. */
  const next = mergeLiveDelta(frame(), {
    cursorMs: 2000,
    rows: [row({ lat: 21.1, lng: 79.1, seenAt: `${DAY}10:00:00+05:30` })],
    positions: [fix("10:00:06", 21.2, 79.2)],
    activity: [],
  });
  assert.equal(next.rows[0].lat, 21.2);
});

test("an empty delta leaves every collection's identity alone", () => {
  const before = frame();
  const next = mergeLiveDelta(before, { cursorMs: 1000, rows: null, positions: [], activity: [] });
  assert.equal(next.rows, before.rows);
  assert.equal(next.tracks, before.tracks);
  assert.equal(next.activity, before.activity);
});
