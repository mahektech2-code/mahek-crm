/**
 * THE DISTRIBUTOR LADDER IS WITHDRAWN FOR NEW LEADS, AND THE OLD ONES ARE NOT.
 *
 *   npm run test
 *
 * Mahek's own decision: distributors are not appointed through MahekOne, so a
 * lead started on that ladder climbed nine rungs towards an approval nobody in
 * the building could give and stalled there — indistinguishable, on every
 * screen, from a lead somebody was actively working.
 *
 * The obvious implementation is to delete the code, and it is the wrong one:
 * `lead_sales_type` stores a CODE and never a label, so deleting it would
 * rewrite the history of the leads already on that ladder rather than stop new
 * ones. `salesTypeLabel` would answer "Not set" on exactly the records that
 * most need explaining, `ladderFor` would drop them onto the legacy six rungs,
 * and the answers underneath them would stop being the ones their gates read.
 *
 * So the three halves pinned here are the three halves of "retired": it is not
 * OFFERED, it is still RESOLVABLE, and the refusal is on the SERVER rather than
 * only in the pickers — a server action is a URL, and an APK cannot be recalled,
 * so a handset built before the decision goes on drawing the chip and goes on
 * posting it.
 *
 * The two server doors are read as TEXT, which is the same thing
 * `timeline-coverage.test.ts` does to catch a bare literal at a call site: the
 * refusal itself needs a database to exercise, and what actually goes wrong is
 * that somebody adds a third door, or deletes the guard from one of these two,
 * and every other test in this suite goes on passing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SALES_TYPES,
  offeredSalesTypes,
  salesTypeIsOffered,
  salesTypeLabel,
} from "../lead-labels";
import { ladderFor, rungOf } from "./lead-ladder";

test("a new lead is not offered the distributor ladder", () => {
  const offered = offeredSalesTypes().map((t) => t.code);

  assert.ok(!offered.includes("distributor"), "distributor is still being offered on new leads");
  assert.deepEqual(
    offered,
    ["direct", "third_party"],
    "the two ladders Mahek actually sells up are what a picker draws",
  );
  assert.equal(salesTypeIsOffered("distributor"), false);
  assert.equal(salesTypeIsOffered("direct"), true);
  assert.equal(salesTypeIsOffered("third_party"), true);
});

test("a lead already on that ladder still reads and still climbs", () => {
  /* Resolvable. A retired type that stopped answering here would relabel every
     existing distributor lead "Not set" on the day it was withdrawn. */
  assert.equal(salesTypeLabel("distributor"), "Distributor");
  assert.ok(SALES_TYPES.some((t) => t.code === "distributor"));

  /* And still on its own ladder, with its own rungs in their own order —
     `ladderFor` falling through to the legacy six would leave a lead standing
     on `distributor_approval` at a rung its own ladder no longer contains. */
  const ladder = ladderFor("distributor");
  assert.ok(
    ladder.includes("distributor_approval"),
    "the distributor ladder has lost the rungs the existing leads are standing on",
  );
  assert.ok(
    rungOf("distributor_approval", "distributor") > rungOf("suspect", "distributor"),
    "the ladder no longer orders itself, so a gate cannot say which way is up",
  );
});

test("both server doors refuse a retired sales type, not just the pickers", () => {
  const doors = [
    /* Moving an existing lead onto it — the handset's ladder sheet posts here. */
    "src/lib/actions/leads.ts",
    /* Raising a new one, by hand or out of a bulk file. */
    "src/lib/actions/lead-intake.ts",
  ];

  for (const door of doors) {
    const source = readFileSync(door, "utf8");
    assert.ok(
      source.includes("salesTypeIsOffered"),
      `${door} writes a sales type without asking whether it is still offered — ` +
        "a picker that no longer draws the chip is not a rule.",
    );
  }
});

test("the refusal is asked AFTER the lead's own type, so an existing one is untouched", () => {
  /*
   * The ORDER of the two questions is the whole of "an existing distributor
   * lead is untouched", and it is invisible in any other kind of check. `setLeadSalesType` answers "that is already the sales type"
   * first; only then does it ask whether the type may be moved ONTO. Reversed,
   * every idempotent re-save of a distributor lead — a retried sync, a
   * double-tap — would come back as a refusal about a decision nobody was
   * making.
   */
  const source = readFileSync("src/lib/actions/leads.ts", "utf8");
  const already = source.indexOf("That is already the sales type.");
  /* The CALL rather than the name, which also appears in the import block at
     the top of the file and would make this assertion pass by accident. */
  const guard = source.indexOf("if (!salesTypeIsOffered(salesType))");

  assert.ok(already > 0 && guard > 0, "setLeadSalesType no longer reads as expected");
  assert.ok(
    already < guard,
    "the retired-ladder refusal is asked before the lead's own type, so a " +
      "distributor lead re-saved as a distributor is refused rather than left alone",
  );
});
