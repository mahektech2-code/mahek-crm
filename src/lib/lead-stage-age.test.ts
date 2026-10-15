import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { stageAgeDays, stageAgeLong, stageAgeShort } from "./sales-lead-pipeline/stage-age";

const text = (p: string) => readFileSync(p, "utf8");

describe("stage age — what may be shown", () => {
  test("no stage date means no figure, never 0", () => {
    assert.equal(stageAgeDays(null, 0), undefined);
    assert.equal(stageAgeDays(undefined, 5), undefined);
    assert.equal(stageAgeDays("", 5), undefined);
    assert.equal(stageAgeDays("2026-10-01", null), undefined);
    assert.equal(stageAgeDays("2026-10-01", Number.NaN), undefined);
  });

  test("a genuine same-day arrival is 0d, a future date is clamped to 0", () => {
    assert.equal(stageAgeDays("2026-10-14", 0), 0);
    assert.equal(stageAgeDays("2026-10-20", -6), 0);
    assert.equal(stageAgeDays("2026-10-10", 4), 4);
  });

  test("the two renderings", () => {
    assert.equal(stageAgeShort(4), "4d");
    assert.equal(stageAgeShort(0), "0d");
    assert.equal(stageAgeShort(-3), "0d");
    assert.equal(stageAgeShort(undefined), null);
    assert.equal(stageAgeShort(null), null);
    assert.equal(stageAgeLong(4, "Suspect"), "4d in Suspect");
    assert.equal(stageAgeLong(undefined, "Suspect"), null);
  });
});

describe("stage badge on the Sales Manager list", () => {
  const ui = text("src/components/sales-lead-pipeline/proto/ui.tsx");

  test("the badge draws `Stage · Nd` from the shared formatter, and plain where there is no age", () => {
    assert.match(ui, /export function PStageBadge\(\{ stage, days \}: \{ stage: Stage \| null; days\?: number \| null \}\)/);
    assert.match(ui, /const age = stageAgeShort\(days\);/);
    assert.match(ui, /\{age \? ` · \$\{age\}` : ""\}/);
  });

  test("the desk row passes it, and the Sales Type badge stays its own badge", () => {
    const src = text("src/components/sales-lead-pipeline/desk/dashboard.tsx");
    assert.match(src, /<PSalesTypeBadge salesType=\{row\.salesType\} \/>/);
    assert.match(src, /<PStageBadge stage=\{row\.stage\} days=\{row\.stageDays\} \/>/);
  });
});

describe("stage age — data flow", () => {
  const sales = text("src/lib/services/sales-service.ts");
  const pipeline = text("src/lib/sales-lead-pipeline/sales-manager-pipeline-service.ts");

  test("both lead-row selects return a null-preserving stageDays (greatest() would turn null into 0)", () => {
    const sel = sales.match(/case when c\.lead_stage_since is null then null\s+else greatest\(\$\{day\}::date - c\.lead_stage_since, 0\) end\)::int as "stageDays"/g);
    assert.equal(sel?.length, 2);
    assert.doesNotMatch(sales, /coalesce\([^)]*lead_stage_since[^)]*\)::int as "stageDays"/);
  });

  test("the list row and the record both map it, the record only where a date exists", () => {
    assert.match(pipeline, /stageDays: lost \? undefined : \(r\.stageDays \?\? undefined\)/);
    assert.match(pipeline, /stageDays: stageAgeDays\(record\.stageSince, record\.stuckDays\)/);
  });
});

describe("stage age — Next Action band", () => {
  const src = text("src/components/sales-lead-pipeline/proto/record-parts.tsx");

  test("adds an 'In stage' cell, drawn only when an age exists", () => {
    assert.match(src, /stageAgeLong\(lead\.stageDays, STAGE_LABEL\[lead\.stage\] \?\? lead\.stage\)/);
    assert.match(src, /\{inStage \? \(/);
    assert.match(src, /In stage/);
  });

  test("both CRM record screens still render the one ProtoNextAction", () => {
    assert.match(text("src/components/sales-lead-pipeline/desk/record-screen.tsx"), /<ProtoNextAction /);
    assert.match(text("src/components/sales-lead-pipeline/lead-record-screen.tsx"), /<ProtoNextAction /);
  });

  test("the /sales-lead-pipeline list is untouched", () => {
    assert.doesNotMatch(text("src/components/sales-lead-pipeline/list-screen.tsx"), /stageDays/);
  });
});

describe("stage date stays in step with the stage", () => {
  const mbos = text("src/lib/actions/mbos.ts");
  const conversion = text("src/lib/services/lead-conversion-service.ts");

  test("the suspect decision dates the move it makes", () => {
    assert.match(mbos, /leadStage: suspectDecisionRung\(p\.suspectDecision, customer\),\s+[^\n]*\n\s+leadStageSince: day,/);
  });

  test("an approved sample dates negotiation", () => {
    assert.match(mbos, /leadStage: "negotiation", leadStageSince: await today\(\)/);
  });

  test("a legacy-ladder stage write dates itself only on a real change", () => {
    assert.match(mbos, /if \(p\.stage !== existing\.leadStage\) changed\.leadStageSince = await today\(\)/);
  });

  test("the verification fallback re-dates only when the rung changes", () => {
    const guarded = mbos.match(/case when \$\{customers\.leadStage\}::text is distinct from/g);
    assert.equal(guarded?.length, 1);
  });

  test("the two direct `won` writes the first audit found no longer exist on main, so none is dated here", () => {
    /* `convertedCustomerId` and `fromLeadId` stopped converting; a lead is won at its order, through
       `conversionColumns`. If either write returns it must be dated, and this is where that is noticed. */
    assert.doesNotMatch(mbos, /changed\.leadStage = "won"/);
    assert.doesNotMatch(mbos, /leadStage: "won"/);
  });

  test("the order conversion dates the rung it writes", () => {
    assert.match(conversion, /leadStage: "won",[\s\S]*?leadStageSince: orderedOn,/);
  });
});
