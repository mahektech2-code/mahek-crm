import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { NURTURE_SEQUENCE } from "../lead-labels";
import {
  chaseOffset,
  expectedReorderEvent,
  nurtureKey,
  sampleChaseDue,
  tasksDueFor,
  type NurtureConfig,
  type NurtureEvent,
  type ReorderCandidate,
  type SampleChaseInput,
} from "./lead-nurture";
import type { RoutineCallConfig } from "./queue";

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

/* ============================================ §13 — the repeat-order call
 *
 * What these pin is the three things that decide whether this rung is worth
 * having at all: that it is dated from the customer's OWN measured cycle
 * rather than from a calendar, that a cycle nobody measured produces nothing,
 * and that a nightly pass over the same shop raises one task rather than one a
 * night. The first is the feature; the other two are how it stops being read.
 */

const ROUTINE: RoutineCallConfig = {
  "queue.routineCallPercent": 70,
  "queue.routineConfidenceSwing": 10,
  "queue.routineMinCycleDays": 15,
};

const shop = (over: Partial<ReorderCandidate> = {}): ReorderCandidate => ({
  customerId: "cus_9",
  lastOrderOn: "2026-08-01",
  cycleDays: 30,
  cycleIsDefault: false,
  cycleConfidence: 50,
  ...over,
});

describe("the repeat-order call", () => {
  test("lands at the configured percentage of the customer's own cycle", () => {
    /* 70% of 30 days is day 21: 1 August plus 21 is 22 August. Confidence of
       50 is the neutral point, so the swing moves nothing here. */
    const due = expectedReorderEvent(shop(), "2026-08-22", ROUTINE, 60);
    assert.equal(due?.trigger, "expected_reorder");
    assert.equal(due?.on, "2026-08-22");
  });

  test("nothing is offered before that day arrives", () => {
    assert.equal(expectedReorderEvent(shop(), "2026-08-21", ROUTINE, 60), null);
  });

  test("a sixty-day buyer is chased at day forty-two, not at day twenty-one", () => {
    /* The whole reason the figure is a percentage of the customer's own cycle:
       a flat lead time would ring a quarterly buyer on the same day it rings a
       monthly one. */
    const due = expectedReorderEvent(shop({ cycleDays: 60 }), "2026-12-31", ROUTINE, 365);
    assert.equal(due?.on, "2026-09-12");
  });

  test("a predictable customer is called later and an erratic one earlier", () => {
    const steady = expectedReorderEvent(shop({ cycleConfidence: 100 }), "2026-12-31", ROUTINE, 365);
    const wobbly = expectedReorderEvent(shop({ cycleConfidence: 0 }), "2026-12-31", ROUTINE, 365);
    /* 80% of 30 is day 24, 60% of 30 is day 18. The swing is the queue
       engine's own, which is the point of not re-deriving it here. */
    assert.equal(steady?.on, "2026-08-25");
    assert.equal(wobbly?.on, "2026-08-19");
  });

  test("a cycle nobody measured produces no call at all", () => {
    /* `buyingCycle.defaultDays` is a number in a registry, not anything this
       shop has ever done. Chasing on it rings a quarterly buyer every month. */
    assert.equal(
      expectedReorderEvent(shop({ cycleIsDefault: true }), "2026-12-31", ROUTINE, 365),
      null,
    );
  });

  test("a customer who has never ordered has no cycle to be counted from", () => {
    assert.equal(
      expectedReorderEvent(shop({ lastOrderOn: null }), "2026-12-31", ROUTINE, 365),
      null,
    );
  });

  test("a day that passed months ago is a dormant account, not a reorder", () => {
    /* Due 22 August; read in December with a sixty-day window. The inactivity
       watch already names this shop, and "they are about due" on somebody who
       has bought nothing since the summer is a sentence a manager stops
       believing. */
    assert.equal(expectedReorderEvent(shop(), "2026-12-31", ROUTINE, 60), null);
  });

  test("the event becomes the sequence's own task, for the lead manager", () => {
    const due = expectedReorderEvent(shop(), "2026-08-22", ROUTINE, 60)!;
    const [task, ...rest] = tasksDueFor([due], "2026-08-22", CONFIG);
    assert.equal(rest.length, 0);
    assert.equal(task.owner, "lead_manager");
    assert.equal(task.title, "Repeat-order call");
    assert.equal(task.dueDate, "2026-08-22");
  });

  test("a second pass over the same shop raises nothing", () => {
    /* The nightly runs again tomorrow, and the day after. Thirty rows for one
       quiet shop is a list people stop reading. */
    const due = expectedReorderEvent(shop(), "2026-08-25", ROUTINE, 60)!;
    const first = tasksDueFor([due], "2026-08-25", CONFIG);
    assert.equal(first.length, 1);
    const second = tasksDueFor([due], "2026-08-26", CONFIG, [first[0].sourceId]);
    assert.equal(second.length, 0);
  });

  test("the next cycle is a new task, because the key is the order behind it", () => {
    /* Keyed on the customer alone, the March task would suppress every cycle
       after it and the shop would be chased exactly once, for ever. */
    const august = expectedReorderEvent(shop(), "2026-08-22", ROUTINE, 60)!;
    const september = expectedReorderEvent(
      shop({ lastOrderOn: "2026-09-01" }),
      "2026-09-22",
      ROUTINE,
      60,
    )!;
    assert.notEqual(august.sourceId, september.sourceId);
    const raised = tasksDueFor([september], "2026-09-22", CONFIG, [
      nurtureKey("expected_reorder", "lead_manager", 0, august.sourceId),
    ]);
    assert.equal(raised.length, 1);
  });

  test("a weekly buyer is asked on their due date rather than early", () => {
    /* At or below `routineMinCycleDays` there is no early call — the one thing
       a short cycle costs, and the same rule the Call Log follows because it
       is the same function. */
    const due = expectedReorderEvent(shop({ cycleDays: 7 }), "2026-12-31", ROUTINE, 365);
    assert.equal(due?.on, "2026-08-08");
  });
});
