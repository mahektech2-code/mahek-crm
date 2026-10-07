import test from "node:test";
import assert from "node:assert/strict";
import { buildDayTimeline, metresWords, minutesWords } from "./salesman-day";

const OPTIONS = { gapMetres: 800, dwellRadiusMetres: 40, dwellMinMinutes: 5, tripBreakMinutes: 5 };
const at = (hhmm: string) => new Date(`2026-10-08T${hhmm}:00+05:30`);

/** A fix every minute from `from` to `to` (inclusive), standing at one place. */
function standing(lat: number, lng: number, from: string, minutes: number) {
  const start = at(from).getTime();
  return Array.from({ length: minutes + 1 }, (_, i) => ({ lat, lng, at: new Date(start + i * 60_000) }));
}

/** A fix every minute walking north ~200 m a minute. */
function walking(lat: number, lng: number, from: string, minutes: number) {
  const start = at(from).getTime();
  return Array.from({ length: minutes + 1 }, (_, i) => ({
    lat: lat + i * 0.0018,
    lng,
    at: new Date(start + i * 60_000),
  }));
}

test("a day reads punch-in, travel, visit, unexplained stop, order, punch-out — in order", () => {
  const trail = [
    ...walking(21.1, 79.0, "09:00", 10), // 09:00–09:10, ~2 km
    ...standing(21.118, 79.0, "09:11", 20), // in the shop 09:11–09:31
    ...walking(21.118, 79.0, "09:32", 10),
    ...standing(21.136, 79.0, "09:43", 15), // a stop no visit explains
  ];
  const { items, summary } = buildDayTimeline(
    {
      sessions: [{ inAt: at("08:55"), outAt: at("18:00") }],
      autoClosed: false,
      trail,
      visits: [{ id: "v1", at: at("09:12"), endAt: at("09:30") }],
      activities: [
        { entityType: "order", entityId: "o1", at: at("09:25") },
        { entityType: "visit", entityId: "v1", at: at("09:12") },
      ],
    },
    OPTIONS,
    at("19:00").getTime(),
  );

  const kinds = items.map((i) => i.kind);
  assert.equal(kinds[0], "punch_in");
  assert.equal(kinds[kinds.length - 1], "punch_out");
  assert.ok(kinds.includes("travel"));
  /* The visit's activity row is the visit — not listed twice. */
  assert.equal(items.filter((i) => i.kind === "visit").length, 1);
  assert.equal(items.filter((i) => i.kind === "activity").length, 1);

  /* The shop's dwell is the visit; only the second stop is unexplained. */
  const stops = items.filter((i) => i.kind === "stop");
  assert.equal(stops.length, 1);
  assert.ok(stops[0].at.getTime() >= at("09:40").getTime(), "the stop after the second walk");
  assert.equal(summary.stops, 1);

  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i].at.getTime() >= items[i - 1].at.getTime(), "in time order");
  }

  assert.equal(summary.visits, 1);
  assert.equal(Math.round(summary.workedMinutes), 9 * 60 + 5);
  assert.equal(Math.round(summary.visitMinutes), 18);
  assert.ok(summary.metres > 3000 && summary.metres < 5000, `walked ~4 km, got ${summary.metres}`);
  assert.equal(summary.open, false);
  assert.equal(summary.lastOutAt?.getTime(), at("18:00").getTime());
});

test("an open day runs to the clock it is handed, and has no finish", () => {
  const { summary, items } = buildDayTimeline(
    { sessions: [{ inAt: at("10:00"), outAt: null }], autoClosed: false, trail: [], visits: [], activities: [] },
    OPTIONS,
    at("11:30").getTime(),
  );
  assert.equal(summary.open, true);
  assert.equal(summary.lastOutAt, null);
  assert.equal(Math.round(summary.workedMinutes), 90);
  assert.deepEqual(items.map((i) => i.kind), ["punch_in"]);
});

test("the last punch-out of an auto-closed day says so; a break is two sessions", () => {
  const { items, summary } = buildDayTimeline(
    {
      sessions: [
        { inAt: at("14:00"), outAt: at("18:00") },
        { inAt: at("09:00"), outAt: at("13:00") },
      ],
      autoClosed: true,
      trail: [],
      visits: [],
      activities: [],
    },
    OPTIONS,
    at("23:00").getTime(),
  );
  const outs = items.filter((i) => i.kind === "punch_out");
  assert.equal(outs.length, 2);
  assert.equal(outs[0].kind === "punch_out" && outs[0].auto, false);
  assert.equal(outs[1].kind === "punch_out" && outs[1].auto, true);
  assert.equal(summary.firstInAt?.getTime(), at("09:00").getTime());
  assert.equal(Math.round(summary.workedMinutes), 8 * 60, "the break is not worked time");
});

test("the words", () => {
  assert.equal(minutesWords(12), "12 min");
  assert.equal(minutesWords(95), "1 h 35 min");
  assert.equal(minutesWords(120), "2 h");
  assert.equal(metresWords(640), "640 m");
  assert.equal(metresWords(1234), "1.2 km");
  assert.equal(metresWords(23_400), "23 km");
});
