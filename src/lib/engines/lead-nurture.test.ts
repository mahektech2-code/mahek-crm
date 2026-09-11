import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { NURTURE_SEQUENCE } from "../lead-labels";
import {
  chaseOffset,
  nurtureKey,
  sampleChaseDue,
  tasksDueFor,
  type NurtureConfig,
  type NurtureEvent,
  type SampleChaseInput,
} from "./lead-nurture";

/* ================================================ §13/§16 — the chasing
 *
 * What these pin is not the wording of a task — that is allowed to improve —
 * but the two things a scheduled pass gets wrong in production: raising the
 * same work twice, and giving up on a customer who has not answered.
 */

const CONFIG: NurtureConfig = { sampleReviewChaseDays: [2, 4, 6] };

const event = (over: Partial<NurtureEvent> = {}): NurtureEvent => ({
  trigger: "prospect_created",
  sourceId: "cus_1",
  on: "2026-09-01",
  ...over,
});

describe("the nurture sequence", () => {
  test("every row's key is distinct, which is what makes them idempotent", () => {
    const keys = new Set(
      NURTURE_SEQUENCE.map((r) => nurtureKey(r.trigger, r.owner, r.after, "x")),
    );
    assert.equal(keys.size, NURTURE_SEQUENCE.length);
  });

  test("each row of the sequence is generated exactly once", () => {
    const triggered = tasksDueFor([event()], "2026-12-31", CONFIG);
    const forProspect = NURTURE_SEQUENCE.filter((r) => r.trigger === "prospect_created");
    assert.equal(triggered.length, forProspect.length);
    assert.equal(new Set(triggered.map((t) => t.sourceId)).size, triggered.length);
  });

  test("a re-run generates nothing — the keys it already holds come back in", () => {
    const first = tasksDueFor([event()], "2026-12-31", CONFIG);
    assert.ok(first.length > 0);
    const second = tasksDueFor(
      [event()],
      "2026-12-31",
      CONFIG,
      first.map((t) => t.sourceId),
    );
    assert.deepEqual(second, []);
  });

  test("the same event passed in twice still produces one task each", () => {
    const twice = tasksDueFor([event(), event()], "2026-12-31", CONFIG);
    assert.equal(new Set(twice.map((t) => t.sourceId)).size, twice.length);
  });

  test("nothing is produced before its day, and everything missed is produced late", () => {
    /* Day 0 rows only. The company profile is day 2 and the brochure day 4. */
    const onTheDay = tasksDueFor([event()], "2026-09-01", CONFIG);
    assert.equal(onTheDay.length, 2);
    assert.ok(onTheDay.every((t) => t.dueDate === "2026-09-01"));

    /* A schedule that dropped a week's ticks still hands over the week. */
    const late = tasksDueFor([event()], "2026-09-20", CONFIG);
    assert.equal(late.length, 4);
    assert.equal(late[0]!.dueDate, "2026-09-01");
  });

  test("two samples raise two tasks; one sample read twice raises one", () => {
    const two = tasksDueFor(
      [
        event({ trigger: "sample_requested", sourceId: "smp_1" }),
        event({ trigger: "sample_requested", sourceId: "smp_2" }),
      ],
      "2026-09-01",
      CONFIG,
    );
    assert.equal(two.length, 2);
  });

  test("the sample-review row follows the configured ladder, not the table's 2", () => {
    const received = event({ trigger: "sample_received", sourceId: "smp_1" });
    const [task] = tasksDueFor([received], "2026-12-31", {
      sampleReviewChaseDays: [5, 9],
    });
    assert.equal(task!.dueDate, "2026-09-06");
    /* …and the KEY is unmoved by that, or editing the setting would raise
       every outstanding review task a second time. */
    assert.equal(task!.sourceId, nurtureKey("sample_received", "lead_manager", 2, "smp_1"));
  });

  test("the salesman and the manager are chased for different things", () => {
    const owners = new Set(tasksDueFor([event()], "2026-09-01", CONFIG).map((t) => t.owner));
    assert.deepEqual([...owners].sort(), ["lead_manager", "salesman"]);
  });
});

describe("§16 — chasing a sample review", () => {
  const sample = (over: Partial<SampleChaseInput> = {}): SampleChaseInput => ({
    id: "smp_1",
    state: "received",
    receivedOn: "2026-09-01",
    chaseCount: 0,
    lastChasedOn: null,
    ...over,
  });

  test("the ladder is day 2, then 4, then 6", () => {
    assert.equal(chaseOffset([2, 4, 6], 1), 2);
    assert.equal(chaseOffset([2, 4, 6], 2), 4);
    assert.equal(chaseOffset([2, 4, 6], 3), 6);
  });

  test("the last interval repeats, for ever, until there is an answer", () => {
    assert.equal(chaseOffset([2, 4, 6], 4), 8);
    assert.equal(chaseOffset([2, 4, 6], 5), 10);
    assert.equal(chaseOffset([2, 4, 6], 20), 40);
  });

  test("a one-rung ladder repeats that rung", () => {
    assert.equal(chaseOffset([3], 1), 3);
    assert.equal(chaseOffset([3], 2), 6);
  });

  test("the first chase falls two days after it arrived", () => {
    assert.equal(sampleChaseDue(sample(), "2026-09-03", [2, 4, 6])?.dueOn, "2026-09-03");
    assert.equal(sampleChaseDue(sample(), "2026-09-02", [2, 4, 6]), null);
  });

  test("a sample nobody has answered about keeps asking past the ladder's end", () => {
    const asked = sample({ chaseCount: 6, lastChasedOn: "2026-09-14" });
    const due = sampleChaseDue(asked, "2026-09-30", [2, 4, 6]);
    assert.equal(due?.chaseNumber, 7);
    assert.equal(due?.dueOn, "2026-09-15");
  });

  test("a reviewed sample generates no chase, and neither does a cancelled one", () => {
    assert.equal(sampleChaseDue(sample({ state: "reviewed" }), "2026-10-01", [2]), null);
    assert.equal(sampleChaseDue(sample({ state: "cancelled" }), "2026-10-01", [2]), null);
    assert.equal(sampleChaseDue(sample({ state: "rejected" }), "2026-10-01", [2]), null);
  });

  test("a trial done with no verdict is exactly what should be chased", () => {
    assert.ok(sampleChaseDue(sample({ state: "trial_done" }), "2026-09-05", [2, 4, 6]));
  });

  test("one that has not arrived yet has nothing to review", () => {
    assert.equal(
      sampleChaseDue(sample({ state: "dispatched", receivedOn: null }), "2026-10-01", [2]),
      null,
    );
  });

  test("two passes on one day ask once", () => {
    const asked = sample({ chaseCount: 1, lastChasedOn: "2026-09-05" });
    assert.equal(sampleChaseDue(asked, "2026-09-05", [2, 4, 6]), null);
  });
});
