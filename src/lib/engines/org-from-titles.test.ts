import { test } from "node:test";
import assert from "node:assert/strict";
import { planChartFromTitles, type TitleEmployee } from "./org-from-titles";

const e = (id: string, position: string | null, reportsTo: string | null, active = true): TitleEmployee => ({
  id,
  name: id,
  position,
  reportsTo,
  active,
});

test("a title exactly one active person holds becomes a chart link", () => {
  const plan = planChartFromTitles([e("head", "Sales Head", null), e("rep", "Salesman", " sales  head ")], []);
  assert.deepEqual(plan.place, [{ employeeId: "rep", managerId: "head" }]);
});

test("two people with the title: nobody is guessed, HR is asked", () => {
  const plan = planChartFromTitles([e("h1", "Area Head", null), e("h2", "Area Head", null), e("rep", "Salesman", "Area Head")], []);
  assert.deepEqual(plan.place, []);
  assert.deepEqual(plan.ambiguous, [{ employeeId: "rep", title: "Area Head", candidateIds: ["h1", "h2"] }]);
});

test("a title nobody active holds is reported, and a leaver does not count", () => {
  const plan = planChartFromTitles([e("old", "Zonal Head", null, false), e("rep", "Salesman", "Zonal Head")], []);
  assert.deepEqual(plan.unknown, [{ employeeId: "rep", title: "Zonal Head" }]);
});

test("somebody already on the chart is never moved", () => {
  const plan = planChartFromTitles([e("head", "Sales Head", null), e("rep", "Salesman", "Sales Head"), e("boss", "MD", null)], [
    { employeeId: "rep", managerId: "boss" },
  ]);
  assert.deepEqual(plan.place, []);
});

test("a link that would close a circle is not written", () => {
  // head already reports to rep; rep's title says he reports to the head.
  const plan = planChartFromTitles([e("head", "Sales Head", null), e("rep", "Salesman", "Sales Head")], [{ employeeId: "head", managerId: "rep" }]);
  assert.deepEqual(plan.place, []);
  assert.equal(plan.ambiguous.length, 1);
});

test("nobody reports to themselves through their own title", () => {
  const plan = planChartFromTitles([e("solo", "Sales Head", "Sales Head")], []);
  assert.deepEqual(plan.place, []);
  assert.deepEqual(plan.unknown, [{ employeeId: "solo", title: "Sales Head" }]);
});
