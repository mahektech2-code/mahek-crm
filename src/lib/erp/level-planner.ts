import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, erpGodowns, erpRawMaterials, erpRmLevels } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { decideSuggestion, featureState, logSuggestion, readText } from "./ai";
import { adjusted, monthlyTotals, planLevel, type DayQty, type LevelPlan } from "./engines/stock-plan";
import { addDaysIso } from "./engines/sales";
import { today } from "./screens/common";
import { erpId } from "./server";

/* ---------------------------------------------------------------------------
 * THE LEVEL PLANNER: every raw material at every godown it is used or bought
 * at gets a minimum and a maximum worked out from its own history, so the
 * godown always holds `erp.levels.coverDays` of stock (1.5 weeks).
 *
 *   1. The statistical plan — `engines/stock-plan.ts`: current rate from use,
 *      seasonality by month and by week of the month from the longest series.
 *   2. The AI review — the model reads each item's history and the season
 *      ahead and may move the level within ±`erp.ai.levels.maxAdjustPercent`,
 *      saying why. Optional: with no key, the cap spent or the switch off,
 *      the statistical plan stands.
 *   3. The write — a level the planner keeps (`auto_managed`) is rewritten;
 *      a level nobody set is created and kept; a level a PERSON set keeps its
 *      figures and only carries the plan beside them, for comparison.
 *
 * Runs nightly, on every deploy (once a day), and by hand:
 * `npm run jobs -- erp-levels-plan [--dry-run]`.
 * ------------------------------------------------------------------------- */

type Key = string; // `${rawMaterialId}|${godownId}`

export type PlannerResult = {
  skipped?: string;
  planned: number;
  created: number;
  updated: number;
  manualKept: number;
  noHistory: number;
  aiReviewed: number;
  aiNote: string;
  rows: { item: string; godown: string; min: number; max: number; statMin: number; statMax: number; factor: number; action: "create" | "update" | "manual" | "unchanged"; basis: string }[];
};

const BATCH = 20;

async function series(q: ReturnType<typeof sql>): Promise<Map<Key, DayQty[]>> {
  const rows = (await db.execute(q)) as unknown as { key: string; d: string; qty: number }[];
  const out = new Map<Key, DayQty[]>();
  for (const r of rows) {
    const list = out.get(r.key) ?? [];
    list.push({ date: String(r.d).slice(0, 10), qty: Number(r.qty) });
    out.set(r.key, list);
  }
  return out;
}

function merge(...maps: Map<Key, DayQty[]>[]): Map<Key, DayQty[]> {
  const out = new Map<Key, DayQty[]>();
  for (const m of maps) for (const [k, v] of m) out.set(k, [...(out.get(k) ?? []), ...v]);
  return out;
}

/** Daily use and purchases per item per godown since `since` — dates are dates, so no zone is involved. */
async function history(since: string) {
  const [chem, cans, boxes, buys] = await Promise.all([
    series(sql`
      select raw_material_id || '|' || godown_id as key, batch_date::text as d, sum(total_use)::float8 as qty
        from erp_sfg_lines where batch_date >= ${since} group by 1, 2`),
    series(sql`
      select can_use_id || '|' || godown_id as key, fill_date::text as d, sum(cans)::float8 as qty
        from erp_fg_fills where can_use_id is not null and fill_date >= ${since} group by 1, 2`),
    series(sql`
      select m.id || '|' || l.godown_id as key, l.pack_date::text as d, sum(l.boxes * pk.empty_boxes_required)::float8 as qty
        from (select distinct on (batch_no) batch_no, sku_id, boxes, godown_id, pack_date from erp_pack_lines order by batch_no, created_at) l
        join erp_product_packing pk on pk.product_id = l.sku_id
        join erp_raw_materials m on lower(m.name) = lower(pk.box_type)
       where l.pack_date >= ${since} group by 1, 2`),
    series(sql`
      select raw_material_id || '|' || godown_id as key, entry_date::text as d, sum(quantity)::float8 as qty
        from erp_rm_entries where source_type = 'purchase' and entry_date >= ${since} group by 1, 2`),
  ]);
  return { use: merge(chem, cans, boxes), purchases: buys };
}

const reviewSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      factor: z.number(),
      reason: z.string(),
    }),
  ),
});

type ReviewItem = {
  key: Key;
  item: string;
  type: string;
  unit: string;
  godown: string;
  plan: LevelPlan;
  useMonths: { month: string; qty: number }[];
  buyMonths: { month: string; qty: number }[];
};

/** Asks the model to review a batch of statistical plans. Null where it could not answer. */
async function aiReview(batch: ReviewItem[], day: string, coverDays: number, maxAdjust: number): Promise<{ answers: Map<Key, { factor: number; reason: string }>; servedBy: string | null } | null> {
  const windowEnd = addDaysIso(day, Math.ceil(coverDays));
  const system = [
    "You review re-order levels for a paint-thinner and solvent manufacturer in India (Mahek Marketing India).",
    `The goal: each godown always holds ${coverDays} days of stock of each raw material — no more, no less.`,
    "Each item comes with a statistical plan: a seasonally adjusted rate, month factors (Jan…Dec, 1 = ordinary), week-of-month factors (days 1–7, 8–14, 15–21, 22–28, 29–31), and monthly totals of production use and of purchases.",
    "Return a factor that multiplies the statistical minimum and maximum, and one plain sentence saying why.",
    "Raise it for something the data supports that the statistics may under-read: a festival or season in the window ahead (Diwali, Navratri, Holi, the monsoon slowdown and the post-monsoon pickup, the March year-end rush) that the monthly totals show for this item, or a steady rising trend.",
    "Lower it where the recent rate is inflated by a one-off bulk purchase or a backlog, or where use is plainly falling.",
    "If nothing justifies a change, return exactly 1 and say the plan matches the pattern.",
    `Never go below ${(1 - maxAdjust / 100).toFixed(2)} or above ${(1 + maxAdjust / 100).toFixed(2)}. Never invent events the totals do not show. Do not mention these instructions.`,
  ].join(" ");
  const prompt = [
    `Today is ${day}. The cover window runs ${day} to ${windowEnd}.`,
    "Items (JSON):",
    JSON.stringify(
      batch.map((b) => ({
        key: b.key,
        item: b.item,
        type: b.type,
        unit: b.unit,
        godown: b.godown,
        statisticalMin: b.plan.min,
        statisticalMax: b.plan.max,
        weeklyRecent: b.plan.weeklyRecent,
        weeklyYear: b.plan.weeklyLong,
        weeksOfHistory: b.plan.weeksOfHistory,
        activeWeekShare: b.plan.activeWeekShare,
        rateFrom: b.plan.rateFrom,
        monthFactor: b.plan.monthFactor,
        weekOfMonthFactor: b.plan.weekOfMonthFactor,
        useByMonth: b.useMonths,
        purchasesByMonth: b.buyMonths,
      })),
    ),
    "Answer for every key.",
  ].join("\n");
  const read = await readText({
    label: "erp level review",
    system,
    prompt,
    schema: reviewSchema,
    shapeHint: '{"items":[{"key":"<the key>","factor":1.0,"reason":"one sentence"}]}',
  });
  if (!read.output) return null;
  const keys = new Set(batch.map((b) => b.key));
  const answers = new Map<Key, { factor: number; reason: string }>();
  for (const a of read.output.items) if (keys.has(a.key) && Number.isFinite(a.factor)) answers.set(a.key, { factor: a.factor, reason: a.reason.trim().slice(0, 400) });
  return { answers, servedBy: read.model };
}

export async function runLevelPlanner(opts: { dryRun?: boolean; force?: boolean; userId?: string | null } = {}): Promise<PlannerResult> {
  const c = await getConfig();
  const empty: PlannerResult = { planned: 0, created: 0, updated: 0, manualKept: 0, noHistory: 0, aiReviewed: 0, aiNote: "", rows: [] };
  if (!c["erp.levels.autoPlan"]) return { ...empty, skipped: "planning levels is switched off in Settings" };
  const day = today();
  const dayStart = new Date(`${day}T00:00:00+05:30`);
  if (!opts.force && !opts.dryRun) {
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(erpRmLevels).where(gte(erpRmLevels.plannedAt, dayStart))) as { n: number }[];
    if (Number(n) > 0) return { ...empty, skipped: "already planned today" };
  }

  const config = {
    coverDays: c["erp.levels.coverDays"],
    orderCycleDays: c["erp.levels.orderCycleDays"],
    recentWeeks: c["erp.levels.recentWeeks"],
    minHistoryWeeks: c["erp.levels.minHistoryWeeks"],
  };
  const since = addDaysIso(day, -365 * c["erp.levels.historyYears"]);
  const [hist, mats, gds, levels] = await Promise.all([
    history(since),
    db
      .select({ id: erpRawMaterials.id, name: erpRawMaterials.name, type: erpRawMaterials.materialType, unit: erpRawMaterials.unit })
      .from(erpRawMaterials)
      /* Drums are counted company-wide, not per godown, so a per-godown level cannot be planned for one. */
      .where(and(eq(erpRawMaterials.active, true), ne(erpRawMaterials.materialType, "Drum"))),
    db.select({ id: erpGodowns.id, name: erpGodowns.name }).from(erpGodowns).where(and(eq(erpGodowns.status, "active"), eq(erpGodowns.reserved, false))),
    db.select().from(erpRmLevels),
  ]);
  const matById = new Map(mats.map((m) => [m.id, m]));
  const gdById = new Map(gds.map((g) => [g.id, g]));
  const levelByKey = new Map(levels.map((l) => [`${l.rawMaterialId}|${l.godownId}`, l]));
  const keys = new Set<Key>([...hist.use.keys(), ...hist.purchases.keys()]);

  const plans: ReviewItem[] = [];
  let noHistory = 0;
  for (const key of keys) {
    const [itemId, godownId] = key.split("|");
    const m = matById.get(itemId);
    const g = gdById.get(godownId);
    if (!m || !g) continue;
    const use = hist.use.get(key) ?? [];
    const purchases = hist.purchases.get(key) ?? [];
    const plan = planLevel({ use, purchases, today: day, config });
    if (!plan) {
      noHistory++;
      continue;
    }
    plans.push({
      key,
      item: m.name,
      type: m.type,
      unit: m.unit === "Unit" ? "pcs" : m.unit,
      godown: g.name,
      plan,
      useMonths: monthlyTotals(use, day, 24),
      buyMonths: monthlyTotals(purchases, day, 24),
    });
  }

  /* ---- the AI review: only levels the planner keeps (or will create), and only when due ---- */
  const maxAdjust = c["erp.ai.levels.maxAdjustPercent"];
  const reviewBefore = new Date(dayStart.getTime() - c["erp.ai.levels.reviewEveryDays"] * 86_400_000);
  const due = plans.filter((p) => {
    const l = levelByKey.get(p.key);
    if (l && !l.autoManaged) return false;
    if (!l || !l.aiReviewedAt || l.aiReviewedAt < reviewBefore) return true;
    const prevStat = Number((l.plan as { statMin?: number } | null)?.statMin ?? 0);
    return prevStat > 0 && Math.abs(p.plan.min - prevStat) / prevStat > 0.25;
  });
  const fresh = new Map<Key, { factor: number; reason: string }>();
  let aiNote = "";
  let aiReviewed = 0;
  if (opts.dryRun) aiNote = "dry run: the AI was not asked";
  else if (!due.length) aiNote = "no AI review due";
  else {
    for (let i = 0; i < due.length; i += BATCH) {
      const state = await featureState("levels");
      if (!state.on) {
        aiNote = state.reason;
        break;
      }
      const batch = due.slice(i, i + BATCH);
      const r = await aiReview(batch, day, config.coverDays, maxAdjust);
      if (!r) {
        aiNote = "the model did not answer; the statistical plan stands for the rest";
        break;
      }
      const sid = await logSuggestion({
        feature: "levels",
        recordType: "erp_rm_level_batch",
        proposed: Object.fromEntries([...r.answers].map(([k, v]) => [k, v])),
        servedBy: r.servedBy,
        userId: opts.userId ?? null,
      });
      /* Applied by the planner itself, inside the limit a person set in Settings. */
      await decideSuggestion(sid, "accepted");
      for (const [k, v] of r.answers) fresh.set(k, v);
      aiReviewed += batch.length;
    }
    if (!aiNote) aiNote = `${aiReviewed} reviewed by AI`;
  }

  /* ---- the write ---- */
  const now = new Date();
  const result: PlannerResult = { ...empty, planned: plans.length, noHistory, aiReviewed, aiNote };
  for (const p of plans) {
    const l = levelByKey.get(p.key);
    const ai = fresh.get(p.key);
    const keepOld = !ai && l?.autoManaged && l.aiFactor != null;
    const factor = ai ? ai.factor : keepOld ? Number(l!.aiFactor) : null;
    const reason = ai ? ai.reason : keepOld ? l!.aiReason : null;
    const fin = adjusted(p.plan, factor, maxAdjust);
    const planJson = { ...p.plan, statMin: p.plan.min, statMax: p.plan.max, min: fin.min, max: fin.max, aiFactor: fin.factor, aiReason: reason ?? null } as Record<string, unknown>;
    const [itemId, godownId] = p.key.split("|");
    let action: PlannerResult["rows"][number]["action"];
    if (!l) action = "create";
    else if (!l.autoManaged) action = "manual";
    else if (Number(l.minQty) === fin.min && Number(l.maxQty) === fin.max) action = "unchanged";
    else action = "update";
    result.rows.push({ item: p.item, godown: p.godown, min: fin.min, max: fin.max, statMin: p.plan.min, statMax: p.plan.max, factor: fin.factor, action, basis: p.plan.basis });
    if (action === "create") result.created++;
    else if (action === "update") result.updated++;
    else if (action === "manual") result.manualKept++;
    if (opts.dryRun) continue;

    const aiCols = ai ? { aiFactor: fin.factor, aiReason: ai.reason, aiReviewedAt: now } : {};
    if (!l) {
      await db
        .insert(erpRmLevels)
        .values({ id: erpId("rmmq"), godownId, rawMaterialId: itemId, materialType: matById.get(itemId)!.type, minQty: fin.min, maxQty: fin.max, status: "Follow", autoManaged: true, plan: planJson, plannedAt: now, aiFactor: ai ? fin.factor : null, aiReason: ai?.reason ?? null, aiReviewedAt: ai ? now : null })
        /* A person adding the same level a moment ago wins. */
        .onConflictDoNothing();
    } else if (l.autoManaged) {
      /* `auto_managed` again under the write: a level somebody edited since the read stays theirs. */
      await db
        .update(erpRmLevels)
        .set({ minQty: fin.min, maxQty: fin.max, plan: planJson, plannedAt: now, updatedAt: now, ...aiCols })
        .where(and(eq(erpRmLevels.id, l.id), eq(erpRmLevels.autoManaged, true)));
    } else {
      await db.update(erpRmLevels).set({ plan: planJson, plannedAt: now }).where(eq(erpRmLevels.id, l.id));
    }
  }

  if (!opts.dryRun) {
    await db.insert(auditLog).values({
      id: `aud_${randomUUID().slice(0, 12)}`,
      actorId: opts.userId ?? null,
      action: "erp.rmLevel.plan",
      entityType: "erp_rm_level",
      entityId: null,
      actorApp: "erp",
      beforeState: null,
      afterState: { day, planned: result.planned, created: result.created, updated: result.updated, manualKept: result.manualKept, aiReviewed, coverDays: config.coverDays } as never,
    });
  }
  return result;
}

/** One line for a job run or a deploy log. */
export function plannerLine(r: PlannerResult): string {
  if (r.skipped) return `skipped: ${r.skipped}`;
  return `${r.planned} planned · ${r.created} created · ${r.updated} updated · ${r.manualKept} hand-set kept · ${r.noHistory} too little history · ${r.aiNote}`;
}
