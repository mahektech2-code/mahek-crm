import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENT_LABELS,
  NO_BAND_LABEL,
  healthSentence,
  healthView,
} from "@/lib/customer-health";
import { HEALTH_BANDS, HEALTH_BAND_LABELS } from "@/lib/engines/inactivity";
import { checkConsistency, defaultConfig } from "@/lib/config/registry";

const T = { watchBelow: 40, strongAtOrAbove: 70 };

/* ---------------------------------------------------------------------------
 * B3-16 — one vocabulary for customer health.
 * ------------------------------------------------------------------------- */

test("a low score never says 'at risk' — that phrase is the band's", () => {
  /*
   * THE WHOLE POINT OF THIS FILE.
   *
   * Two screens used the same two words for different questions: the
   * salesman's list called a customer at risk below a SCORE of 40, and the
   * owner's report called one at risk at 1.25 CYCLES overdue. A shop ordering
   * every week that owed money read as "at risk" of leaving — which it was
   * not, and sending somebody to win it back is the wasted call that follows.
   */
  const view = healthView({ band: "active", score: 12, components: null }, T);
  assert.equal(view.bandLabel, "Active", "the band is the retention answer");
  assert.equal(view.watch, true, "and the score still says it is worth a look");
  assert.doesNotMatch(
    healthSentence(view).toLowerCase(),
    /at risk/,
    "a score must never borrow the band's phrase",
  );
});

test("a customer who has never ordered gets no band, said in words", () => {
  /* They have not stopped buying — they have not started. A blank cell reads
     as missing data; this is a real and different answer. */
  const view = healthView({ band: null, score: null, components: null }, T);
  assert.equal(view.band, null);
  assert.equal(view.bandLabel, NO_BAND_LABEL);
  assert.equal(view.bandTone, "muted");
  assert.deepEqual(view.concerns, []);
});

test("the band drives the headline tone, not the score", () => {
  /* A shop that has gone quiet is the problem even if its five components
     look fine, and the colour has to say so. */
  const quiet = healthView({ band: "lost", score: 95, components: null }, T);
  assert.equal(quiet.bandTone, "danger");
  assert.equal(quiet.scoreTone, "success", "the score keeps its own reading");
});

test("concerns name the components that are dragging, worst first", () => {
  /* A score nobody can decompose is a number nobody argues with, and one
     nobody argues with is one nobody acts on. The engine has stored the
     components since it shipped and nothing read them until now. */
  const view = healthView(
    {
      band: "active",
      score: 38,
      components: { paymentBehaviour: 10, complaints: 25, orderRecency: 90 },
    },
    T,
  );
  assert.deepEqual(
    view.concerns.map((c) => c.component),
    ["paymentBehaviour", "complaints"],
    "worst first, and nothing above the threshold",
  );
  assert.equal(view.concerns[0].label, COMPONENT_LABELS.paymentBehaviour);
  assert.match(healthSentence(view), /watch payments and complaints/);
});

test("every band the engine can produce has a label here", () => {
  /* Read off HEALTH_BANDS rather than a list typed out, so a fifth band fails
     this the moment it is added rather than rendering as a blank pill. */
  for (const band of HEALTH_BANDS) {
    const view = healthView({ band, score: 50, components: null }, T);
    assert.equal(view.bandLabel, HEALTH_BAND_LABELS[band]);
    assert.ok(view.bandLabel.length > 0, `${band} has no word`);
  }
});

test("a score cannot be both strong and worth watching", () => {
  /* Enforced in configuration rather than resolved by branch order, because a
     rule the code silently works around is a rule nobody knows is broken. */
  const bad = { ...defaultConfig(), "mbos.health.strongAtOrAbove": 30, "mbos.health.atRiskBelow": 40 };
  const problems = checkConsistency(bad);
  assert.ok(
    problems.some((p) => /strong at or above/i.test(p)),
    `expected a health threshold complaint, got: ${problems.join(" | ")}`,
  );
  assert.equal(
    checkConsistency(defaultConfig()).filter((p) => /strong at or above/i.test(p)).length,
    0,
    "the shipped defaults must not trip it",
  );
});
