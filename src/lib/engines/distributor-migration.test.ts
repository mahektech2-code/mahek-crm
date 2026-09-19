/**
 * THE RULE THAT DECIDES WHO MAY BE MIGRATED OFF THE DISTRIBUTOR LADDER, read
 * off the action's source.
 *
 * Mahek's own words: "Prospective Distributor is a historical lead TYPE;
 * Distributor means formally APPOINTED by Mahek." Everything in the migration
 * hangs off that one sentence, and the half that is easy to get backwards is
 * `active_distributor` — the ladder's terminal, which IS the appointment. A
 * company Mahek has signed an agreement with must not be filed as a direct
 * customer somebody still has to qualify.
 *
 * Read as TEXT rather than executed, like `timeline-coverage.test.ts` beside
 * it: the action is a server action behind a capability and a database, and the
 * three things asserted here are all absences or constants — exactly the shape
 * a later tidy-up removes without noticing, and exactly what no type check
 * sees.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { DIRECT_LADDER, DISTRIBUTOR_LADDER, THIRD_PARTY_LADDER } from "./lead-ladder";

const SRC = fs.readFileSync("src/lib/actions/lead-distributor-migration.ts", "utf8");

describe("migrating a prospective distributor", () => {
  test("an APPOINTED distributor is refused", () => {
    assert.match(
      SRC,
      /from === "active_distributor"/,
      "the appointment stage must be refused by name, or an appointed distributor is filed as a shop to qualify",
    );
  });

  test("only a lead actually on that ladder may be migrated", () => {
    assert.match(SRC, /was !== "distributor"/);
  });

  test("it is a manager's, and the capability is named", () => {
    assert.match(SRC, /requireCapability\("lead\.override"\)/);
  });

  /* The history is the point of the whole exercise: Mahek asked for the
     original type and rung to be preserved. Both are written — the transition
     row carries the OLD sales type, and the audit row carries both halves. */
  test("the old classification is written to history", () => {
    assert.match(SRC, /salesType: was/, "the transition must record the ladder it happened on");
    assert.match(
      SRC,
      /beforeState: \{ leadSalesType: was, leadStage: from \}/,
      "the audit row must carry what it was",
    );
  });

  test("a migration is recorded as an override, not as a passed gate", () => {
    /* No gate was asked and none opened — a manager placed it by hand. Calling
       it `passed` would put a lead on the record as having met conditions
       nobody evaluated. */
    assert.match(SRC, /kind: "overridden"/);
  });
});

describe("where a migrated lead may land", () => {
  /* `qualification` is the default because it is the highest rung the three
     ladders SHARE — the last point that means the same thing on all of them.
     If that ever stops being true the default is wrong, so it is asserted
     rather than assumed. */
  test("qualification is on every ladder", () => {
    for (const ladder of [DIRECT_LADDER, THIRD_PARTY_LADDER, DISTRIBUTOR_LADDER]) {
      assert.ok(ladder.includes("qualification"));
    }
  });

  test("the distributor-only rungs exist on no other ladder", () => {
    const shared = new Set([...DIRECT_LADDER, ...THIRD_PARTY_LADDER]);
    for (const rung of [
      "management_review",
      "commercial_discussion",
      "distributor_approval",
      "distributor_agreement",
      "initial_stock_order",
      "active_distributor",
    ] as const) {
      assert.ok(
        !shared.has(rung),
        `${rung} is on a shared ladder — a migrated lead could land on it, which would assert work nobody did`,
      );
    }
  });
});
