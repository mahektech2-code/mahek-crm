/**
 * THE VISIT CAP AND THE CREATE DOOR — the two rules §11 found enforced in code
 * and silently not firing.
 *
 * Both were the same fault wearing two faces: a rule written down in one
 * vocabulary and asked in another. The cap knew `new` and `contacted`, which is
 * the legacy ladder's foot and nothing else, so every lead the funnel plants —
 * at `suspect` — was invisible to it at both ends. The create door knew no
 * vocabulary at all and wrote whatever arrived.
 *
 * What this file pins is not the wording of either rule. It is that the rungs a
 * lead can BE PLANTED ON and the rungs the cap CAN SEE are the same set, walked
 * rather than listed — which is the assertion that would have failed the day
 * `suspect` was added, and the only one that will fail the day a fourth ladder
 * is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECT_LADDER,
  DISTRIBUTOR_LADDER,
  LEGACY_LADDER,
  THIRD_PARTY_LADDER,
  isUndecidedSuspect,
  ladderFor,
  plantableStage,
} from "./lead-ladder";
import type { LeadSalesType } from "../lead-labels";

/** The four answers `customers.lead_sales_type` can hold, null included. */
const SALES_TYPES: readonly (LeadSalesType | null)[] = [
  null,
  "direct",
  "third_party",
  "distributor",
];

test("the funnel's foot is `suspect` and the legacy foot is `new`, by name", () => {
  /* Pinned by NAME as well as by walking, because the walk below would pass
     just as happily if both feet were renamed together — and the server's
     refusal sentences, the handset's card and §B's own wording all say these
     two words out loud. */
  assert.equal(LEGACY_LADDER[0], "new");
  assert.equal(DIRECT_LADDER[0], "suspect");
  assert.equal(THIRD_PARTY_LADDER[0], "suspect");
  assert.equal(DISTRIBUTOR_LADDER[0], "suspect");
});

test("every rung a lead can be planted on is a rung the cap can see", () => {
  /* THE TEST THAT WOULD HAVE CAUGHT IT. A lead arrives on the foot of its own
     ladder and on no other rung, so the cap has to recognise all four feet or
     there is a whole ladder's worth of leads nobody is ever asked to decide
     about. */
  for (const salesType of SALES_TYPES) {
    const foot = plantableStage(null, salesType);
    assert.equal(
      isUndecidedSuspect(foot),
      true,
      `a lead planted at ${foot} (${salesType ?? "no sales type"}) is invisible to the visit cap`,
    );
  }
});

test("the cap stops at the rung the decision moves a lead to", () => {
  /* `prospect` is what the answer MOVES a Suspect to, so capping it would
     demand the same decision a second time — which is the "a qualified prospect
     visited a fourth time is a negotiation, not a stall" rule read one rung
     down. The legacy ladder genuinely has no such rung: `new` and `contacted`
     both mean nobody has decided, which is why both stay capped and why nothing
     about the old book moves. */
  assert.equal(isUndecidedSuspect("contacted"), true);
  assert.equal(isUndecidedSuspect("prospect"), false);

  for (const salesType of SALES_TYPES) {
    const ladder = ladderFor(salesType);
    for (const rung of ladder.slice(2)) {
      assert.equal(
        isUndecidedSuspect(rung),
        false,
        `${rung} is above the decision and must not be asked to justify a visit`,
      );
    }
  }
});

test("a rung nobody recognises is not a Suspect", () => {
  /* The safe direction. Both callers hold TEXT — the server reads a column
     behind an enum, the handset a column that may still carry the six
     capitalised words — and a cap that fired on an unrecognised word would
     demand a decision about a lead nobody can place. */
  assert.equal(isUndecidedSuspect(null), false);
  assert.equal(isUndecidedSuspect(undefined), false);
  assert.equal(isUndecidedSuspect(""), false);
  assert.equal(isUndecidedSuspect("Suspect"), false);
  assert.equal(isUndecidedSuspect("won"), false);
  assert.equal(isUndecidedSuspect("lost"), false);
  assert.equal(isUndecidedSuspect("on_hold"), false);
});

test("a create is planted at the foot, whatever rung it names", () => {
  for (const salesType of SALES_TYPES) {
    const foot = ladderFor(salesType)[0];
    for (const rung of ladderFor(salesType).slice(1)) {
      assert.equal(
        plantableStage(rung, salesType),
        foot,
        `a create naming ${rung} would have arrived above the gate that guards it`,
      );
    }
    /* Not a climb — a closure, and the reason for it is demanded separately. */
    assert.equal(plantableStage("lost", salesType), "lost");
    assert.equal(plantableStage(foot, salesType), foot);
  }
});

test("what the deployed handset actually sends is planted exactly as sent", () => {
  /* The other half of the argument for correcting rather than refusing: no
     honest payload is touched by any of this. `captureLead` sends `suspect`
     where the salesman answered §2 and `new` where the build never asked. */
  assert.equal(plantableStage("suspect", "direct"), "suspect");
  assert.equal(plantableStage("new", null), "new");
});

/**
 * AND NEITHER END MAY KEEP A LIST OF ITS OWN.
 *
 * The bug was not that either list was wrong when it was typed — both were
 * right about the ladder that existed. It was that there were two, in two
 * runtimes that cannot import from each other, so the day a third vocabulary
 * arrived only one of them heard about it. A test that only checked the
 * predicate would pass on the day somebody writes the list out again.
 */
test("the cap is asked through the shared predicate at both ends", () => {
  const ends = [
    "src/lib/actions/mbos.ts",
    "mbos-app/src/engines/leads.ts",
  ];
  for (const file of ends) {
    const source = readFileSync(file, "utf8");
    /* The prose is stripped before the second assertion, because this codebase
       explains itself in comments and both of those files now QUOTE the list
       they used to keep in order to say why they stopped. A guard that reads a
       comment as code is one somebody silences rather than satisfies — the zone
       guards next door learned the same thing the same way. */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.match(
      source,
      /isUndecidedSuspect/,
      `${file} enforces the visit cap and no longer asks the one predicate`,
    );
    assert.doesNotMatch(
      code,
      /\[\s*["']new["']\s*,\s*["']contacted["']\s*\]|\[\s*["']New["']\s*,\s*["']Contacted["']\s*\]/,
      `${file} has a suspect-stage list of its own again — that is the bug, not a copy of the fix`,
    );
  }
});
