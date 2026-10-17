import { round1 } from "./scoring";

/* ---------------------------------------------------------------------------
 * ADVERSE IMPACT AND CALIBRATION (spec §5.8, design §7.10). Pure.
 *
 * Aggregate only. These functions take counts and score lists, never a
 * person — the bias auditor monitors outcomes, not individual decisions, and
 * an alert is advice to HR, never an automatic change to the process.
 * ------------------------------------------------------------------------- */

export type GroupCount = { group: string; entered: number; passed: number };

export type ImpactRow = {
  group: string;
  entered: number;
  passed: number;
  /** passed ÷ entered, 0..1; null when nobody entered. */
  rate: number | null;
  /** rate ÷ the highest group's rate. */
  ratio: number | null;
  /** Below the threshold AND enough people to mean anything. */
  flagged: boolean;
  /** Too few to read — said, rather than drawn as a ratio. */
  small: boolean;
};

/** The four-fifths rule: each group's selection rate against the highest. */
export function adverseImpact(groups: GroupCount[], threshold = 0.8, minGroup = 10): ImpactRow[] {
  const rates = groups.map((g) => (g.entered ? g.passed / g.entered : null));
  const top = Math.max(0, ...rates.filter((r): r is number => r != null && groups[rates.indexOf(r)].entered >= minGroup));
  return groups.map((g, i) => {
    const rate = rates[i];
    const small = g.entered < minGroup;
    const ratio = rate != null && top > 0 ? Math.round((rate / top) * 100) / 100 : null;
    return { group: g.group, entered: g.entered, passed: g.passed, rate, ratio, small, flagged: !small && ratio != null && ratio < threshold };
  });
}

export type InterviewerStats = {
  interviewer: string;
  n: number;
  mean: number;
  /** Mean minus the panel mean, in points of the 0–100 scale. */
  delta: number;
  /** Share of AI scores accepted unchanged — 1.0 is itself a flag (PRD R2). */
  agreement: number | null;
  graceUses: number;
  graceUp: number;
  graceDown: number;
  label: "Lenient" | "Severe" | "In line" | "Too few to say";
};

export function calibrate(
  rows: { interviewer: string; score: number; grace: number; aiAccepted: number; aiTotal: number }[],
  minN = 5,
  band = 6,
): { panelMean: number | null; stats: InterviewerStats[] } {
  if (!rows.length) return { panelMean: null, stats: [] };
  const panelMean = round1(rows.reduce((n, r) => n + r.score, 0) / rows.length);
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.interviewer, [...(by.get(r.interviewer) ?? []), r]);
  const stats = [...by.entries()].map(([interviewer, rs]) => {
    const mean = round1(rs.reduce((n, r) => n + r.score, 0) / rs.length);
    const delta = round1(mean - panelMean);
    const aiTotal = rs.reduce((n, r) => n + r.aiTotal, 0);
    const graced = rs.filter((r) => r.grace !== 0);
    const label: InterviewerStats["label"] = rs.length < minN ? "Too few to say" : delta > band ? "Lenient" : delta < -band ? "Severe" : "In line";
    return {
      interviewer,
      n: rs.length,
      mean,
      delta,
      agreement: aiTotal ? Math.round((rs.reduce((n, r) => n + r.aiAccepted, 0) / aiTotal) * 100) / 100 : null,
      graceUses: graced.length,
      graceUp: graced.filter((r) => r.grace > 0).length,
      graceDown: graced.filter((r) => r.grace < 0).length,
      label,
    };
  });
  return { panelMean, stats: stats.sort((a, b) => b.n - a.n) };
}

/** Pearson correlation; null with fewer than five pairs. For score-to-performance. */
export function correlation(pairs: [number, number][]): number | null {
  if (pairs.length < 5) return null;
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  return dx && dy ? Math.round((num / Math.sqrt(dx * dy)) * 100) / 100 : null;
}
