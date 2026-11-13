import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breaksOf,
  cfgProblem,
  closeFromBreak,
  dayVerdict,
  endSession,
  gapMs,
  idleState,
  isLocked,
  mirrors,
  phaseOf,
  settle,
  startSession,
  workedMs,
  type WorkdaySession,
} from "./workday";

const M = 60_000;
const H = 60 * M;
const cfg = { warnMinutes: 25, breakMinutes: 30, outMinutes: 60, breakOutMinutes: 120 };
const nine = Date.UTC(2026, 10, 13, 3, 30); // 9:00 IST

test("a day starts with nothing and is locked until a stretch runs", () => {
  assert.equal(phaseOf([]), "none");
  assert.equal(isLocked("none"), true);
  const s = startSession([], nine)!;
  assert.equal(phaseOf(s), "working");
  assert.equal(isLocked("working"), false);
  assert.equal(startSession(s, nine + M), null, "two stretches cannot run at once");
});

test("a break ends a stretch and resuming starts the next; the gap is not work", () => {
  let s = startSession([], nine)!;
  s = endSession(s, nine + 4 * H, "break", "Lunch")!;
  assert.equal(phaseOf(s), "break");
  s = startSession(s, nine + 4 * H + 35 * M)!;
  s = endSession(s, nine + 9 * H, "punch_out")!;
  assert.equal(phaseOf(s), "done");
  assert.equal(workedMs(s, nine + 10 * H) / M, 9 * 60 - 35);
  assert.equal(gapMs(s, nine + 10 * H) / M, 35);
  assert.deepEqual(breaksOf(s, nine + 10 * H).map((b) => [b.kind, b.reason, (b.to! - b.from) / M]), [["break", "Lunch", 35]]);
});

test("idle 30 minutes becomes a break dated from the last activity, not from when it was noticed", () => {
  const s = startSession([], nine)!;
  const last = nine + 2 * H;
  /* Noticed 47 minutes later — the record is the same as if noticed at 30. */
  const r = settle(s, last, last + 47 * M, cfg);
  assert.equal(r.changed, true);
  assert.equal(phaseOf(r.sessions), "auto_break");
  assert.equal(r.sessions[0].out, last);
  assert.equal(workedMs(r.sessions, last + 47 * M) / M, 120);
});

test("idle under 30 minutes changes nothing, and warns from 25", () => {
  const s = startSession([], nine)!;
  const last = nine + H;
  assert.equal(settle(s, last, last + 29 * M, cfg).changed, false);
  assert.equal(idleState(s, last, last + 24 * M, cfg).warn, false);
  assert.equal(idleState(s, last, last + 25 * M, cfg).warn, true);
});

test("idle an hour closes the day at the last activity, whether it was working or on an automatic break", () => {
  const s = startSession([], nine)!;
  const last = nine + 3 * H;
  const direct = settle(s, last, last + 61 * M, cfg);
  assert.equal(phaseOf(direct.sessions), "auto_out");
  assert.equal(direct.sessions[0].out, last);
  const viaBreak = settle(settle(s, last, last + 31 * M, cfg).sessions, last, last + 61 * M, cfg);
  assert.equal(phaseOf(viaBreak.sessions), "auto_out");
  assert.equal(viaBreak.sessions[0].out, last);
  assert.equal(isLocked("auto_out"), true);
});

test("settling is idempotent", () => {
  const s = startSession([], nine)!;
  const once = settle(s, nine + H, nine + 2 * H, cfg);
  const twice = settle(once.sessions, nine + H, nine + 2 * H, cfg);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.sessions, once.sessions);
});

test("an activity from before a stretch began does not shorten it", () => {
  let s = startSession([], nine)!;
  s = endSession(s, nine + H, "break")!;
  s = startSession(s, nine + 2 * H)!;
  /* Last activity is from the first stretch; the second is only 10 minutes old. */
  assert.equal(settle(s, nine + H, nine + 2 * H + 10 * M, cfg).changed, false);
});

test("a manual break past its limit closes the day at the break's start", () => {
  let s = startSession([], nine)!;
  s = endSession(s, nine + 2 * H, "break", "Personal")!;
  assert.equal(settle(s, nine + 2 * H, nine + 2 * H + 119 * M, cfg).changed, false);
  const r = settle(s, nine + 2 * H, nine + 2 * H + 121 * M, cfg);
  assert.equal(phaseOf(r.sessions), "auto_out");
  assert.equal(workedMs(r.sessions, nine + 6 * H) / M, 120);
});

test("punching out from a break ends the day where the break began", () => {
  let s = startSession([], nine)!;
  s = endSession(s, nine + 2 * H, "break")!;
  const c = closeFromBreak(s)!;
  assert.equal(phaseOf(c), "done");
  assert.equal(workedMs(c, nine + 8 * H) / M, 120);
  assert.equal(closeFromBreak(startSession([], nine)!), null);
});

test("an approved claim counts as work and comes off the stoppage", () => {
  let s = startSession([], nine)!;
  s = settle(s, nine + 2 * H, nine + 3 * H, cfg).sessions; // auto_out at 11:00
  s = startSession(s, nine + 3 * H)!;
  s = endSession(s, nine + 8 * H, "punch_out")!;
  const claim = [{ from: nine + 2 * H, to: nine + 3 * H }];
  assert.equal(workedMs(s, 0) / M, 7 * 60);
  assert.equal(workedMs(s, 0, claim) / M, 8 * 60);
  const m = mirrors(s, nine + 9 * H, claim);
  assert.equal(m.firstIn, nine);
  assert.equal(m.lastOut, nine + 8 * H);
  assert.equal(m.stoppageMin, 0);
});

test("the mirrors make out − in − stoppage equal the worked total", () => {
  let s = startSession([], nine)!;
  s = endSession(s, nine + 4 * H, "break")!;
  s = startSession(s, nine + 4 * H + 40 * M)!;
  s = endSession(s, nine + 9 * H, "punch_out")!;
  const m = mirrors(s, nine + 10 * H);
  assert.equal((m.lastOut! - m.firstIn!) / M - m.stoppageMin, workedMs(s, 0) / M);
  /* While on a break the day is open: no last out yet, the break so far counted. */
  const open = endSession(startSession([], nine)!, nine + H, "break")!;
  const mo = mirrors(open, nine + H + 15 * M);
  assert.equal(mo.lastOut, null);
  assert.equal(mo.stoppageMin, 15);
});

test("present at 8 hours, half day at 4, absent below; a day off worked is extra; a running day is not judged", () => {
  const base = { presentMin: 480, halfMin: 240, offDay: null, running: false };
  assert.equal(dayVerdict({ ...base, workedMin: 480 }), "present");
  assert.equal(dayVerdict({ ...base, workedMin: 479 }), "half_day");
  assert.equal(dayVerdict({ ...base, workedMin: 240 }), "half_day");
  assert.equal(dayVerdict({ ...base, workedMin: 239 }), "absent");
  assert.equal(dayVerdict({ ...base, workedMin: 600, offDay: "holiday" }), "extra");
  assert.equal(dayVerdict({ ...base, workedMin: 10, running: true }), "working");
});

test("the idle settings must come in order", () => {
  assert.equal(cfgProblem(cfg), null);
  assert.ok(cfgProblem({ ...cfg, warnMinutes: 30 }));
  assert.ok(cfgProblem({ ...cfg, outMinutes: 30 }));
});

test("a session list survives a JSON round trip", () => {
  const s: WorkdaySession[] = endSession(startSession([], nine)!, nine + H, "break", "Tea")!;
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
