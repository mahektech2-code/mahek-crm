import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DESK_VIEWS,
  groupBySalesman,
  parseDeskView,
  queueCounts,
  suspectCount,
} from "./sales-lead-pipeline/desk";
import type { DeskRow } from "./sales-lead-pipeline/types";

function row(id: string, stage: DeskRow["stage"], over: Partial<DeskRow> = {}): DeskRow {
  return {
    id, name: `Lead ${id}`, salesType: null, stage, lost: false, priority: null,
    owner: "Mahesh", ownerId: "u1", queues: [], ...over,
  };
}

describe("Sales Manager desk — Suspect view", () => {
  const rows = [
    row("a", "suspect"),
    row("b", "new", { ownerId: "u2", owner: "Anil" }),
    row("c", "prospect", { queues: ["verify"] }),
    row("d", "suspect", { queues: ["overdue"] }),
    row("e", null, { lost: true }),
  ];

  test("sits right after All leads and before Verify prospect, and parses from ?view=", () => {
    assert.deepEqual(DESK_VIEWS.slice(0, 3), ["all", "suspect", "verify"]);
    assert.equal(parseDeskView("suspect"), "suspect");
    assert.equal(parseDeskView("nonsense"), "all");
  });

  test("counts suspect and legacy new, never a lost or later-rung lead", () => {
    assert.equal(suspectCount(rows), 3);
  });

  test("the list holds exactly the counted leads, grouped by salesman", () => {
    const groups = groupBySalesman(rows, { view: "suspect", q: "", salesmanId: "" });
    assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), 3);
    assert.equal(groups.length, 2);
  });

  test("search and salesman filter still narrow inside the view", () => {
    assert.equal(groupBySalesman(rows, { view: "suspect", q: "", salesmanId: "u2" })[0].rows.length, 1);
    assert.equal(groupBySalesman(rows, { view: "suspect", q: "anil", salesmanId: "" })[0].rows.length, 1);
  });

  test("existing queue counts are untouched", () => {
    assert.deepEqual(queueCounts(rows), { all: 5, verify: 1, review: 0, sample: 0, order: 0, overdue: 1, nurture: 0 });
  });
});
