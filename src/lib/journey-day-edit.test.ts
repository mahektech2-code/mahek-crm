import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { arrangedByOffice, dayEdit, officeMayEdit, saveStopsLabel } from "@/lib/journey-day-edit";

const stops = (...ids: string[]) => ids.map((customerId) => ({ customerId, status: "planned" }));

describe("editing a day's shops", () => {
  test("a picker that has changed nothing keeps every saved shop ticked", () => {
    const e = dayEdit(stops("a", "b"), [], []);
    assert.deepEqual([...e.selected], ["a", "b"]);
    assert.equal(e.total, 2);
  });

  test("adding joins the list; only an unticked shop leaves it", () => {
    const e = dayEdit(stops("a", "b", "c"), ["d", "e"], ["b"]);
    assert.deepEqual([...e.selected].sort(), ["a", "c", "d", "e"]);
    assert.equal(saveStopsLabel(e), "Save 4 stops (2 added, 1 removed)");
  });

  test("a visited shop cannot be removed or added again", () => {
    const e = dayEdit([{ customerId: "a", status: "visited" }], ["a"], ["a"]);
    assert.equal(e.total, 1);
    assert.deepEqual([e.added, e.removed], [[], []]);
  });

  test("a draft that has already landed is not counted twice", () => {
    const e = dayEdit(stops("a", "b"), ["b"], ["gone"]);
    assert.equal(saveStopsLabel(e), "Save 2 stops (0 added, 0 removed)");
  });
});

describe("who arranged a planned day", () => {
  test("the office, only where the salesman created none of it", () => {
    assert.equal(arrangedByOffice([{ createdById: "boss" }], "sam"), true);
    assert.equal(arrangedByOffice([{ createdById: "boss" }, { createdById: "sam" }], "sam"), false);
    assert.equal(arrangedByOffice([{ createdById: null }], "sam"), false);
    assert.equal(arrangedByOffice([], "sam"), false);
  });

  test("a planned day is edited only if the office arranged it and it has not gone by", () => {
    const day = (planDate: string, officeArranged: boolean) => ({ dayState: "planned", planDate, officeArranged });
    assert.equal(officeMayEdit(day("2026-11-26", true), "2026-11-26"), true);
    assert.equal(officeMayEdit(day("2026-11-25", true), "2026-11-26"), false);
    assert.equal(officeMayEdit(day("2026-11-27", false), "2026-11-26"), false);
    for (const dayState of ["proposed", "agreed", "refused"]) {
      assert.equal(officeMayEdit({ dayState, planDate: "2026-11-01", officeArranged: false }, "2026-11-26"), true);
    }
  });
});
