import { test } from "node:test";
import assert from "node:assert/strict";

import {
  areaAnswerState,
  dayOwed,
  dayWhere,
  rankShopCities,
  monthGrid,
  monthParam,
  stopFate,
  sumTallies,
  tallyDay,
} from "./journey-days";
import { areasSignature } from "./territory-signature";

const TODAY = "2026-10-04";

test("a stop still planned on a day that has gone is MISSED, not planned", () => {
  assert.equal(stopFate("planned", "2026-10-01", TODAY), "missed");
  assert.equal(stopFate("planned", TODAY, TODAY), "pending");
  assert.equal(stopFate("planned", "2026-10-09", TODAY), "pending");
  assert.equal(stopFate("visited", "2026-10-01", TODAY), "visited");
  assert.equal(stopFate("skipped", "2026-10-01", TODAY), "skipped");
});

test("a day is tallied allocated against visited, with off-plan visits beside it", () => {
  const t = tallyDay(
    {
      planDate: "2026-10-02",
      stops: [{ status: "visited" }, { status: "visited" }, { status: "skipped" }, { status: "planned" }],
    },
    [{ wasPlanned: true }, { wasPlanned: true }, { wasPlanned: false }],
    TODAY,
  );
  assert.deepEqual(
    { ...t },
    { allocated: 4, visited: 2, skipped: 1, missed: 1, pending: 0, offPlan: 1, visits: 3, adherencePct: 50 },
  );
});

test("no route is no adherence, never 0%", () => {
  const t = tallyDay({ planDate: "2026-10-02", stops: [] }, [{ wasPlanned: false }], TODAY);
  assert.equal(t.adherencePct, null);
  assert.equal(t.offPlan, 1);
});

test("summed adherence is recomputed from the totals, never averaged", () => {
  const a = tallyDay({ planDate: "2026-10-01", stops: [{ status: "visited" }] }, [], TODAY);
  const b = tallyDay(
    { planDate: "2026-10-02", stops: Array.from({ length: 9 }, () => ({ status: "planned" })) },
    [],
    TODAY,
  );
  assert.equal(sumTallies([a, b]).adherencePct, 10);
});

test("whose move it is follows the state AND whether the day has gone", () => {
  const plan = (dayState: "proposed" | "refused" | "agreed" | "planned", planDate: string, stops = 0) => ({
    planDate,
    dayState,
    stops: Array.from({ length: stops }),
  });
  assert.equal(dayOwed(plan("refused", "2026-10-06"), TODAY).owner, "manager");
  assert.equal(dayOwed(plan("proposed", "2026-10-06"), TODAY).owner, "salesman");
  assert.equal(dayOwed(plan("agreed", "2026-10-06"), TODAY).owner, "salesman");
  assert.equal(dayOwed(plan("refused", "2026-10-01"), TODAY).owner, null);
  assert.equal(dayOwed(plan("proposed", "2026-10-01"), TODAY).text, "Proposed, never answered");
  assert.equal(dayOwed(plan("planned", TODAY, 3), TODAY).text, "On the road today");
  assert.equal(dayOwed(null, TODAY).owner, null);
});

test("a month is drawn as whole weeks, Monday first", () => {
  const g = monthGrid("2026-10"); // 1 Oct 2026 is a Thursday, 31 Oct a Saturday
  assert.equal(g.from, "2026-09-28");
  assert.equal(g.to, "2026-11-01");
  assert.equal(g.days.length % 7, 0);
  assert.equal(monthGrid("2026-12").to, "2027-01-03");
});

test("a month from the URL is checked, and falls back to today's", () => {
  assert.equal(monthParam("2026-08", TODAY), "2026-08");
  assert.equal(monthParam("2026-13", TODAY), "2026-10");
  assert.equal(monthParam(undefined, TODAY), "2026-10");
});

test("an acceptance counts only for the allocation he was shown", () => {
  const areas = [{ kind: "city", value: "Nagpur", parent: "Maharashtra" }];
  const now = areasSignature(areas);
  const at = "2026-10-01T10:00:00Z";
  assert.equal(
    areaAnswerState(areas, { kind: "accept", at, signature: now, requested: [], reason: null, state: "accepted" }).key,
    "accepted",
  );
  assert.equal(
    areaAnswerState(areas, { kind: "accept", at, signature: "old", requested: [], reason: null, state: "accepted" }).key,
    "accepted-earlier",
  );
  assert.equal(
    areaAnswerState(areas, { kind: "change", at, signature: now, requested: ["Wardha"], reason: "closer", state: "pending" }).key,
    "change-pending",
  );
  assert.equal(areaAnswerState([], null).key, "none-allocated");
  assert.equal(areaAnswerState(areas, null).key, "unanswered");
});

test("a day arranged from shops is placed by the shops, most shops first", () => {
  assert.deepEqual(rankShopCities(["Ulhasnagar", "Ambernath", " Ambernath ", null, ""]), ["Ambernath", "Ulhasnagar"]);
  assert.deepEqual(dayWhere({ city: null, shopCities: ["Ambernath"] }), { text: "Ambernath", fromShops: true });
  assert.deepEqual(dayWhere({ city: null, shopCities: ["A", "B", "C", "D"] }), { text: "A · B +2", fromShops: true });
  // An agreed city is the plan's own word and wins over the shops.
  assert.deepEqual(dayWhere({ city: "Nagpur", shopCities: ["Wardha"] }), { text: "Nagpur", fromShops: false });
  assert.deepEqual(dayWhere({ city: null, beat: "East", shopCities: [] }), { text: "East", fromShops: false });
  assert.deepEqual(dayWhere({ city: null }), { text: null, fromShops: false });
});
