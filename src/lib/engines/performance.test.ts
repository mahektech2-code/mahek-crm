import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { checkConsistency, defaultConfig } from "../config/registry";
import {
  BP,
  achievementBp,
  alertsFor,
  cappedBp,
  focusLines,
  forecast,
  mixCategoryScoreBp,
  rankPerformance,
  ratingFor,
  scoreMix,
  weightedScore,
  type MixBand,
  type PerformanceRankInput,
} from "./performance";

/* ============================== E10 — how a salesman is measured
 *
 * The brief this is written from is explicit about what it is trying to stop:
 * a salesman looking excellent because prices went up, and a salesman looking
 * excellent because he sold only what sells itself. Most of what follows pins
 * one of those two.
 */

const C = defaultConfig();

const band = (over: Partial<MixBand> = {}): MixBand => ({
  categoryId: "universal",
  name: "Universal",
  minimumBp: 2500,
  targetBp: 3000,
  stretchBp: 3500,
  ...over,
});

/* The brief's own worked example, §4–§7, so the four categories below are the
   ones a reader of the PRD will recognise. */
const BANDS: MixBand[] = [
  band(),
  band({ categoryId: "pu", name: "PU", minimumBp: 1500, targetBp: 2000, stretchBp: 2500 }),
  band({ categoryId: "nano", name: "Nano", minimumBp: 1000, targetBp: 2000, stretchBp: 2500 }),
  band({ categoryId: "other", name: "Other", minimumBp: 3000, targetBp: 3000, stretchBp: 3000 }),
];

describe("achievement", () => {
  test("the brief's revenue example: 13.5L against 13L is 103.85%", () => {
    const bp = achievementBp(1_350_000_00, 1_300_000_00);
    assert.equal(bp, 10385);
  });

  test("the brief's volume example: 9,500 L against 10,000 L is 95%", () => {
    assert.equal(achievementBp(9_500_000, 10_000_000), 9500);
  });

  test("a target of zero is null, which is NOT zero achievement", () => {
    // Nobody was asked. Scoring it 0% punishes somebody for a question never
    // put to them; scoring it 100% pays them for it.
    assert.equal(achievementBp(500, 0), null);
    assert.equal(achievementBp(0, 0), null);
  });

  test("the ceiling caps the score without touching the achievement", () => {
    const raw = achievementBp(4_000_000, 1_000_000)!; // 400%
    assert.equal(raw, 40000);
    assert.equal(cappedBp(raw, C), 12000); // 120%, the configured ceiling
  });
});

describe("the score", () => {
  test("the brief's worked example, §13, comes to 91.4 out of 100", () => {
    // Component achievements are given directly, as the brief gives them.
    const result = weightedScore(
      [
        { key: "revenue", actual: 0, target: 0, achievementBp: 10400 },
        { key: "volume", actual: 0, target: 0, achievementBp: 9500 },
        { key: "mix", actual: 0, target: 0, achievementBp: 7500 },
        { key: "newCustomers", actual: 0, target: 0, achievementBp: 6700 },
        { key: "collection", actual: 0, target: 0, achievementBp: 9800 },
        { key: "activity", actual: 0, target: 0, achievementBp: 9000 },
      ],
      C,
    );
    // 36.40 + 19.00 + 15.00 + 6.70 + 9.80 + 4.50
    assert.equal(result.totalBp, 9140);
    assert.equal(ratingFor(result.totalBp, C), "Excellent");
  });

  test("an untargeted component is DROPPED and its weight shared out", () => {
    // Nobody set a collection target. The other five must still be scored out
    // of a hundred, or the screen shows 90/100 computed out of 90.
    const result = weightedScore(
      [
        { key: "revenue", actual: 100, target: 100 },
        { key: "volume", actual: 100, target: 100 },
        { key: "mix", actual: 0, target: 0, achievementBp: BP },
        { key: "newCustomers", actual: 3, target: 3 },
        { key: "collection", actual: 50_000, target: 0 }, // never asked
        { key: "activity", actual: 100, target: 100 },
      ],
      C,
    );
    assert.equal(result.untargeted.length, 1);
    assert.equal(result.untargeted[0], "collection");
    // Everything else at exactly target, so a full hundred — not ninety.
    assert.equal(result.totalBp, BP);

    const revenue = result.components.find((c) => c.key === "revenue")!;
    // 35 of the 90 live weight, restated out of 100.
    assert.ok(Math.abs(revenue.effectiveWeight - (35 / 90) * 100) < 1e-9);
  });

  test("with nothing targeted at all there is no score, and it says so", () => {
    const result = weightedScore(
      [
        { key: "revenue", actual: 900, target: 0 },
        { key: "volume", actual: 900, target: 0 },
      ],
      C,
    );
    assert.equal(result.totalBp, 0);
    assert.equal(result.untargeted.length, 2);
  });

  test("one runaway component cannot carry the score past the ceiling", () => {
    const result = weightedScore(
      [
        { key: "revenue", actual: 10_000, target: 1_000 }, // 1000%
        { key: "volume", actual: 0, target: 1_000 },
        { key: "mix", actual: 0, target: 0, achievementBp: 0 },
        { key: "newCustomers", actual: 0, target: 3 },
        { key: "collection", actual: 0, target: 1_000 },
        { key: "activity", actual: 0, target: 100 },
      ],
      C,
    );
    // Revenue is capped at 120% of a 35-point weight: 42 points, and nothing
    // else scored. Without the ceiling this month would read as 350/100.
    assert.equal(result.totalBp, 4200);
    assert.equal(ratingFor(result.totalBp, C), "Poor");
  });
});

describe("product mix", () => {
  test("shares are computed on value, and the brief's §6 example holds", () => {
    const mix = scoreMix(
      BANDS,
      [
        { categoryId: "universal", valuePaise: 300_000_00, millilitres: 0 },
        { categoryId: "pu", valuePaise: 150_000_00, millilitres: 0 },
        { categoryId: "nano", valuePaise: 200_000_00, millilitres: 0 },
        { categoryId: "other", valuePaise: 350_000_00, millilitres: 0 },
      ],
      C,
    );
    const by = (id: string) => mix.categories.find((c) => c.categoryId === id)!;
    assert.equal(by("universal").actualBp, 3000); // 30%
    assert.equal(by("pu").actualBp, 1500); // 15%
    assert.equal(by("nano").actualBp, 2000); // 20%
  });

  test("a category is scored against its own band, not against the others", () => {
    const b = band(); // min 25%, target 30%, stretch 35%
    assert.equal(mixCategoryScoreBp(3000, b, C), 10000); // on target
    assert.equal(mixCategoryScoreBp(2500, b, C), 6000); // on the minimum
    assert.equal(mixCategoryScoreBp(3500, b, C), 11000); // at stretch
    assert.equal(mixCategoryScoreBp(0, b, C), 0);
    // Between anchors it interpolates rather than stepping: 27.5% is halfway
    // from minimum to target, so halfway from 60 to 100.
    assert.equal(mixCategoryScoreBp(2750, b, C), 8000);
  });

  test("selling nothing but the easy line does NOT score a good mix", () => {
    // This is the failure the whole component exists to prevent. Everything is
    // Other; Other is far above its target, and the three strategic
    // categories are at nothing.
    const mix = scoreMix(
      BANDS,
      [{ categoryId: "other", valuePaise: 1_000_000_00, millilitres: 0 }],
      C,
    );
    assert.equal(mix.categories.find((c) => c.categoryId === "other")!.actualBp, BP);
    // Weighted by what was ASKED, so the 70% of weight sitting on the three
    // strategic categories all scores zero.
    assert.ok(
      mix.achievementBp !== null && mix.achievementBp < 3500,
      `expected a poor mix, got ${mix.achievementBp}`,
    );
  });

  test("stretch on one category cannot pay for another being absent", () => {
    const mix = scoreMix(
      BANDS,
      [
        { categoryId: "universal", valuePaise: 700_000_00, millilitres: 0 },
        { categoryId: "other", valuePaise: 300_000_00, millilitres: 0 },
      ],
      C,
    );
    assert.ok(mix.achievementBp !== null && mix.achievementBp <= BP);
  });

  test("nothing sold is null, not a mix score of zero", () => {
    // A salesman who has billed nothing on the 2nd has not failed his mix.
    const mix = scoreMix(BANDS, [], C);
    assert.equal(mix.achievementBp, null);
  });

  test("the status names which side of the band a share landed", () => {
    const mix = scoreMix(
      BANDS,
      [
        { categoryId: "universal", valuePaise: 320_000_00, millilitres: 0 },
        { categoryId: "pu", valuePaise: 140_000_00, millilitres: 0 },
        { categoryId: "nano", valuePaise: 180_000_00, millilitres: 0 },
        { categoryId: "other", valuePaise: 360_000_00, millilitres: 0 },
      ],
      C,
    );
    const by = (id: string) => mix.categories.find((c) => c.categoryId === id)!;
    assert.equal(by("universal").status, "on-target"); // 32%, target 30
    assert.equal(by("pu").status, "below-minimum"); // 14%, minimum 15
    assert.equal(by("nano").status, "below-target"); // 18%, minimum 10
    assert.equal(by("other").status, "stretch"); // 36%, stretch 30
  });
});

describe("the price-rise control", () => {
  /*
   * The single most important thing in the brief. Revenue at or above target
   * with volume well below it means the money came from the price list, and
   * it is exactly the month in which somebody would otherwise be congratulated.
   */
  test("revenue at 105% with volume at 88% is flagged", () => {
    const alerts = alertsFor(
      {
        revenueBp: 10500,
        volumeBp: 8800,
        collectionBp: BP,
        activityBp: BP,
        newCustomerActual: 2,
        newCustomerTarget: 3,
        mix: scoreMix(BANDS, [], C),
        workingDaysElapsed: 26,
        workingDaysTotal: 26,
      },
      C,
    );
    const flag = alerts.find((a) => a.key === "price-not-volume");
    assert.ok(flag, "expected the revenue-without-volume alert");
    assert.equal(flag!.severity, "high");
    assert.match(flag!.message, /price realisation/);
  });

  test("revenue and volume both at target is NOT flagged", () => {
    const alerts = alertsFor(
      {
        revenueBp: 10500,
        volumeBp: 10200,
        collectionBp: BP,
        activityBp: BP,
        newCustomerActual: 3,
        newCustomerTarget: 3,
        mix: scoreMix(BANDS, [], C),
        workingDaysElapsed: 26,
        workingDaysTotal: 26,
      },
      C,
    );
    assert.equal(
      alerts.find((a) => a.key === "price-not-volume"),
      undefined,
    );
  });

  test("volume behind while revenue is ALSO behind is a shortfall, not a price rise", () => {
    // Both under target is an ordinary bad month. Saying "the revenue came
    // from price realisation" about it would be false and would teach people
    // to ignore the alert.
    const alerts = alertsFor(
      {
        revenueBp: 7000,
        volumeBp: 6500,
        collectionBp: BP,
        activityBp: BP,
        newCustomerActual: 3,
        newCustomerTarget: 3,
        mix: scoreMix(BANDS, [], C),
        workingDaysElapsed: 26,
        workingDaysTotal: 26,
      },
      C,
    );
    assert.equal(
      alerts.find((a) => a.key === "price-not-volume"),
      undefined,
    );
  });
});

describe("month-end forecast", () => {
  test("the brief's §38 example projects 12L against a 13L target", () => {
    const f = forecast({
      actual: 800_000_00,
      target: 1_300_000_00,
      workingDaysElapsed: 20,
      workingDaysTotal: 30,
    });
    assert.equal(f.projected, 1_200_000_00);
    assert.equal(f.projectedAchievementBp, 9231); // 92.3%
    assert.equal(f.shortfall, 500_000_00);
    assert.equal(f.workingDaysRemaining, 10);
    assert.equal(f.perRemainingDay, 50_000_00);
  });

  test("no day worked yet is no forecast, rather than a multiplication", () => {
    const f = forecast({
      actual: 0,
      target: 1_300_000_00,
      workingDaysElapsed: 0,
      workingDaysTotal: 26,
    });
    assert.equal(f.projected, null);
    assert.equal(f.projectedAchievementBp, null);
    // The gap is still known and still worth saying.
    assert.equal(f.shortfall, 1_300_000_00);
  });

  test("a target already met asks for nothing more per day", () => {
    const f = forecast({
      actual: 1_400_000_00,
      target: 1_300_000_00,
      workingDaysElapsed: 20,
      workingDaysTotal: 26,
    });
    assert.equal(f.shortfall, null);
    assert.equal(f.perRemainingDay, null);
  });
});

describe("pace", () => {
  test("half the working month gone at 30% of target is flagged", () => {
    const alerts = alertsFor(
      {
        revenueBp: 3000,
        volumeBp: 3000,
        collectionBp: BP,
        activityBp: BP,
        newCustomerActual: 1,
        newCustomerTarget: 3,
        mix: scoreMix(BANDS, [], C),
        workingDaysElapsed: 13,
        workingDaysTotal: 26,
      },
      C,
    );
    assert.ok(alerts.find((a) => a.key === "behind-pace"));
  });

  test("a slow first day is not a slow month", () => {
    // Nothing has been sold and no working day has completed. An alert here
    // fires on the 1st of every month for everybody, which is how people learn
    // to ignore alerts.
    const alerts = alertsFor(
      {
        revenueBp: 0,
        volumeBp: 0,
        collectionBp: null,
        activityBp: null,
        newCustomerActual: 0,
        newCustomerTarget: 3,
        mix: scoreMix(BANDS, [], C),
        workingDaysElapsed: 0,
        workingDaysTotal: 26,
      },
      C,
    );
    assert.equal(
      alerts.find((a) => a.key === "behind-pace"),
      undefined,
    );
  });
});

describe("rating", () => {
  test("the default bands read off the brief's §14 table", () => {
    assert.equal(ratingFor(9500, C), "Excellent");
    assert.equal(ratingFor(9000, C), "Excellent");
    assert.equal(ratingFor(8999, C), "Very good");
    assert.equal(ratingFor(8000, C), "Very good");
    assert.equal(ratingFor(7000, C), "Good");
    assert.equal(ratingFor(6000, C), "Needs improvement");
    assert.equal(ratingFor(5999, C), "Poor");
    assert.equal(ratingFor(0, C), "Poor");
  });
});

describe("what to do today", () => {
  test("the gaps come back worst-first, in the units the work is done in", () => {
    const score = weightedScore(
      [
        { key: "revenue", actual: 1_130_000_00, target: 1_300_000_00 },
        { key: "volume", actual: 8_900_000, target: 10_000_000 },
        { key: "newCustomers", actual: 2, target: 3 },
        { key: "collection", actual: 960_000_00, target: 1_000_000_00 },
        { key: "activity", actual: 90, target: 100 },
      ],
      C,
    );
    const mix = scoreMix(
      BANDS,
      [
        { categoryId: "universal", valuePaise: 320_000_00, millilitres: 0 },
        { categoryId: "pu", valuePaise: 140_000_00, millilitres: 0 },
        { categoryId: "nano", valuePaise: 180_000_00, millilitres: 0 },
        { categoryId: "other", valuePaise: 360_000_00, millilitres: 0 },
      ],
      C,
    );
    const lines = focusLines(score, mix, "2026-08-21");

    assert.ok(lines.length > 0);
    // The revenue line says rupees; nothing says "achievement basis points".
    const revenue = lines.find((l) => l.key === "revenue");
    assert.ok(revenue, "expected a revenue gap line");
    assert.match(revenue!.message, /^₹1,70,000 short/);

    const newCust = lines.find((l) => l.key === "newCustomers");
    assert.equal(newCust!.message, "1 more new customer needed this month.");

    // PU is the category furthest below its target share, so it is named.
    assert.ok(lines.some((l) => l.message.startsWith("PU is")));
  });

  test("a component at or above target produces no line", () => {
    const score = weightedScore(
      [{ key: "revenue", actual: 200, target: 100 }],
      C,
    );
    assert.equal(focusLines(score, scoreMix([], [], C), "2026-08-21").length, 0);
  });
});

describe("configuration is refused rather than silently obeyed", () => {
  test("weights that do not total 100 are a problem", () => {
    const bad = { ...C, "performance.weightRevenue": 40 };
    const problems = checkConsistency(bad);
    assert.ok(
      problems.some((p) => p.includes("performance weights total 105")),
      problems.join("\n"),
    );
  });

  test("the shipped defaults are consistent", () => {
    const problems = checkConsistency(C).filter((p) =>
      p.toLowerCase().includes("performance") || p.toLowerCase().includes("mix scoring"),
    );
    assert.deepEqual(problems, []);
  });

  test("mix anchors that fall as the share rises are refused", () => {
    const bad = { ...C, "performance.mixScoreAtStretch": 50 };
    assert.ok(checkConsistency(bad).some((p) => p.includes("Mix scoring must not fall")));
  });

  test("rating bands that do not reach the bottom are refused", () => {
    const bad = {
      ...C,
      "performance.ratingBands": [{ min: 60, label: "Good" }],
    };
    assert.ok(checkConsistency(bad).some((p) => p.includes("lowest rating band")));
  });
});

describe("rankPerformance — the founder dashboard's company-wide roster", () => {
  const reading = (over: Partial<PerformanceRankInput>): PerformanceRankInput => ({
    userId: "u1",
    userName: "A",
    hasTarget: true,
    totalBp: 9000,
    revenuePaise: 100_000,
    ...over,
  });

  test("best score first", () => {
    const ranked = rankPerformance([
      reading({ userId: "a", totalBp: 7000 }),
      reading({ userId: "b", totalBp: 9500 }),
      reading({ userId: "c", totalBp: 8000 }),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.userId),
      ["b", "c", "a"],
    );
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2, 3],
    );
  });

  test("a tied score is broken by revenue", () => {
    const ranked = rankPerformance([
      reading({ userId: "low-revenue", totalBp: 9000, revenuePaise: 50_000 }),
      reading({ userId: "high-revenue", totalBp: 9000, revenuePaise: 200_000 }),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.userId),
      ["high-revenue", "low-revenue"],
    );
  });

  test("a genuine tie on both shares a rank, and the next rank skips", () => {
    const ranked = rankPerformance([
      reading({ userId: "a", totalBp: 9000, revenuePaise: 100_000 }),
      reading({ userId: "b", totalBp: 9000, revenuePaise: 100_000 }),
      reading({ userId: "c", totalBp: 8000, revenuePaise: 100_000 }),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 1, 3],
    );
  });

  test("nobody with a published target sorts last, unranked", () => {
    const ranked = rankPerformance([
      reading({ userId: "no-target", hasTarget: false, totalBp: 0, revenuePaise: 900_000 }),
      reading({ userId: "has-target", totalBp: 6000 }),
    ]);
    assert.deepEqual(
      ranked.map((r) => r.userId),
      ["has-target", "no-target"],
    );
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[1].rank, null);
  });
});
