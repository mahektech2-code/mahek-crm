/* ---------------------------------------------------------------------------
 * PLANNED RE-ORDER LEVELS: how much of a raw material a godown should hold so
 * that it always has `coverDays` of stock (1.5 weeks by default), read from
 * its own history.
 *
 * Pure, like every engine here: it takes the daily series and the date and
 * performs no I/O, so the whole model is tested without a database.
 *
 * Two series feed it, and each answers a different question:
 *
 *   - USE (what production drew: SFG lines for chemicals, fills for cans,
 *     packing for boxes) is the RATE. It is what empties the shelf.
 *   - PURCHASES (the purchase register's posted lots) usually reach back
 *     further, so where they cover more years they give the SEASONALITY.
 *     Buying is lumpy, which is why it is never the rate where use exists.
 *
 * Where only one series exists it answers both.
 *
 * The forecast for a day is   base daily rate × month factor × week-of-month
 * factor. The month factor says that, say, October runs 30% above the year;
 * the week-of-month factor says the last week of a month runs heavier than
 * the first. Both are SHRUNK towards 1 by how much history stands behind
 * them, so one odd October cannot make every October look like it.
 *
 * The minimum is the forecast over the next `coverDays` days; the maximum
 * adds one order cycle on top. Recomputed nightly, so the window rolls and a
 * level rises ahead of a busy month rather than after it.
 * ------------------------------------------------------------------------- */

export type DayQty = { date: string; qty: number };

export type PlanConfig = {
  /** Days of stock the minimum must cover — 10.5 is a week and a half. */
  coverDays: number;
  /** Days of use bought on top of the minimum, so a PO is not raised daily. */
  orderCycleDays: number;
  /** Recent weeks the current rate is measured over. */
  recentWeeks: number;
  /** Below this many weeks of history no level is planned at all. */
  minHistoryWeeks: number;
};

export type PlanBasis = "use" | "purchases";
export type Confidence = "high" | "medium" | "low";

export type LevelPlan = {
  min: number;
  max: number;
  /** Which series gave the rate, and which gave the seasonality. */
  rateFrom: PlanBasis;
  seasonFrom: PlanBasis;
  /** Forecast use over the next cover window and the order cycle. */
  coverForecast: number;
  maxForecast: number;
  /** Seasonally adjusted base rate, per day and per week. */
  baseDaily: number;
  weeklyLong: number;
  weeklyRecent: number;
  weeksOfHistory: number;
  yearsOfSeason: number;
  /** Share of weeks with any use at all — low means it is used in bursts. */
  activeWeekShare: number;
  /** Index 0 = January. 1 means an ordinary month. */
  monthFactor: number[];
  /** Index 0 = days 1–7, … index 4 = days 29–31. */
  weekOfMonthFactor: number[];
  confidence: Confidence;
  /** Plain sentences for the screen: peaks, slow months, the trend. */
  notes: string[];
  /** One sentence: how the figure was worked out. */
  basis: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEK_NAMES = ["1st week", "2nd week", "3rd week", "4th week", "last days"];

/* ------------------------------------------------------------- dates (UTC) */

function toDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}
function fromDay(n: number): { y: number; m: number; d: number } {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}
export function weekOfMonth(dayOfMonth: number): number {
  return Math.min(4, Math.floor((dayOfMonth - 1) / 7));
}

/* ------------------------------------------------------------------ series */

/**
 * A dense daily array from the first day with any quantity up to yesterday.
 * Days after `today` are ignored; a series with no positive day is empty.
 */
export function denseSeries(points: DayQty[], todayIso: string): { start: number; qty: number[] } {
  const end = toDay(todayIso) - 1;
  const byDay = new Map<number, number>();
  for (const p of points) {
    const n = toDay(p.date);
    if (n > end || !(p.qty > 0)) continue;
    byDay.set(n, (byDay.get(n) ?? 0) + p.qty);
  }
  if (!byDay.size) return { start: end + 1, qty: [] };
  const start = Math.min(...byDay.keys());
  const qty = Array.from({ length: end - start + 1 }, (_, i) => byDay.get(start + i) ?? 0);
  return { start, qty };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Caps a one-off spike (a bulk purchase, a backlog cleared in a day) at mean + 3σ. */
function winsor(xs: number[]): number[] {
  if (xs.length < 4) return xs;
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  const cap = m + 3 * sd;
  return xs.map((x) => Math.min(x, cap));
}

/* ------------------------------------------------------------- seasonality */

/**
 * Month and week-of-month factors from a daily series, by RATIO TO MOVING
 * AVERAGE: each day is divided by the average of the days around it — a year
 * around it for the month factor, a month around it for the week factor — so
 * growth (or decline) over the years is taken out before any pattern is read.
 * Without it a growing business reads its latest months as "busy months".
 *
 * Each factor is then shrunk towards 1 by how much of it was observed: a month
 * seen in three years moves further than one seen once.
 */
export function seasonalFactors(s: { start: number; qty: number[] }): { month: number[]; week: number[]; years: number } {
  const flat = { month: Array(12).fill(1), week: Array(5).fill(1), years: 0 };
  const n = s.qty.length;
  if (n < 90) return flat;
  const prefix = [0];
  for (const q of s.qty) prefix.push(prefix[prefix.length - 1] + q);
  const around = (i: number, half: number) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    return (prefix[hi] - prefix[lo]) / (hi - lo);
  };

  /* Months need a full year to compare one with another. */
  let month: number[] = Array(12).fill(1);
  if (n >= 365) {
    const sum = Array(12).fill(0);
    const days = Array(12).fill(0);
    for (let i = 0; i < n; i++) {
      const base = around(i, 182);
      if (base <= 0) continue;
      const { m } = fromDay(s.start + i);
      sum[m] += s.qty[i] / base;
      days[m] += 1;
    }
    month = sum.map((x, m) => {
      if (!days[m]) return 1;
      const seen = days[m] / 30.4; // how many of this month we have seen
      /* Three Octobers move the factor 92% of the way; one, 80%. Shrinking
         harder than that under-reads every busy month, which is the costly
         mistake: it runs the shelf dry exactly when it is needed. */
      const k = seen / (seen + 0.25);
      return clamp(1 + (x / days[m] - 1) * k, 0.4, 2.5);
    });
  }

  /* Weeks of the month against the month around them, so a busy October does
     not read as a busy last week. */
  const wSum = Array(5).fill(0);
  const wDays = Array(5).fill(0);
  for (let i = 0; i < n; i++) {
    const base = around(i, 15);
    if (base <= 0) continue;
    const { d } = fromDay(s.start + i);
    const w = weekOfMonth(d);
    wSum[w] += s.qty[i] / base;
    wDays[w] += 1;
  }
  const monthsSeen = n / 30.4;
  const week = wSum.map((x, w) => {
    if (!wDays[w]) return 1;
    const k = monthsSeen / (monthsSeen + 1);
    return clamp(1 + (x / wDays[w] - 1) * k, 0.5, 2);
  });
  return { month, week, years: Math.floor((n / 365) * 10) / 10 };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/* -------------------------------------------------------------------- plan */

/** Rounds a quantity up to something a person orders: whole units, 1 at least. */
export function roundUp(x: number): number {
  if (x <= 0) return 0;
  if (x < 10) return Math.ceil(x);
  if (x < 100) return Math.ceil(x / 5) * 5;
  return Math.ceil(x / 10) * 10;
}

/** The forecast total over [from, from + days), a fractional last day counted in part. */
export function forecastTotal(baseDaily: number, monthF: number[], weekF: number[], fromDay0: number, days: number): number {
  let total = 0;
  for (let i = 0; i < Math.ceil(days); i++) {
    const part = Math.min(1, days - i);
    const { m, d } = fromDay(fromDay0 + i);
    total += baseDaily * monthF[m] * weekF[weekOfMonth(d)] * part;
  }
  return total;
}

/**
 * The plan for one item at one godown, or null where there is too little
 * history to say anything (a level nobody can stand behind is worse than no
 * level, because it raises requirements).
 */
export function planLevel(p: { use: DayQty[]; purchases: DayQty[]; today: string; config: PlanConfig }): LevelPlan | null {
  const use = denseSeries(p.use, p.today);
  const buy = denseSeries(p.purchases, p.today);
  const minDays = p.config.minHistoryWeeks * 7;
  const useOk = use.qty.length >= minDays;
  const buyOk = buy.qty.length >= minDays;
  if (!useOk && !buyOk) return null;

  const rateFrom: PlanBasis = useOk ? "use" : "purchases";
  const rateS = rateFrom === "use" ? use : buy;
  const seasonFrom: PlanBasis = buyOk && buy.qty.length > use.qty.length * 1.25 ? "purchases" : rateFrom;
  const seasonS = seasonFrom === "use" ? use : buy;
  /* Months from the longest series; weeks of the month from USE only. When a
     purchase lands is the buyer's calendar, not the shelf's: two drums bought
     on the 1st and the 21st would otherwise read as a shelf that empties in
     those weeks and stands still in the others. */
  const months = seasonalFactors(seasonS);
  const weekly = useOk ? (seasonFrom === "use" ? months.week : seasonalFactors(use).week) : Array(5).fill(1);
  const f = { month: months.month, week: weekly, years: months.years };

  /* Weekly totals, newest last, each taken back out of its month's factor. */
  const weeks: number[] = [];
  const deseason: number[] = [];
  for (let end = rateS.qty.length; end - 7 >= 0; end -= 7) {
    let sum = 0;
    let adj = 0;
    for (let i = end - 7; i < end; i++) {
      const { m, d } = fromDay(rateS.start + i);
      sum += rateS.qty[i];
      adj += rateS.qty[i] / (f.month[m] * f.week[weekOfMonth(d)]);
    }
    weeks.unshift(sum);
    deseason.unshift(adj);
  }
  if (!weeks.length) return null;
  const capped = winsor(deseason);
  const last52 = capped.slice(-52);
  const recent = capped.slice(-p.config.recentWeeks);
  const longW = mean(last52);
  const recentW = mean(recent);
  /* Recent use leads, the year steadies it: a real change shows within weeks
     while a quiet fortnight does not halve the shelf. */
  const baseWeekly = last52.length >= p.config.recentWeeks * 2 ? 0.6 * recentW + 0.4 * longW : recentW;
  if (baseWeekly <= 0) return null;
  const baseDaily = baseWeekly / 7;

  const todayN = toDay(p.today);
  const coverForecast = forecastTotal(baseDaily, f.month, f.week, todayN, p.config.coverDays);
  const maxForecast = forecastTotal(baseDaily, f.month, f.week, todayN, p.config.coverDays + p.config.orderCycleDays);
  const min = roundUp(coverForecast);
  const max = Math.max(min, roundUp(maxForecast));

  const activeWeekShare = weeks.filter((w) => w > 0).length / weeks.length;
  const confidence: Confidence =
    weeks.length >= 52 && activeWeekShare >= 0.5 ? "high" : weeks.length >= 12 && activeWeekShare >= 0.3 ? "medium" : "low";

  const notes: string[] = [];
  const peak = f.month.indexOf(Math.max(...f.month));
  const slow = f.month.indexOf(Math.min(...f.month));
  if (f.month[peak] >= 1.2) notes.push(`${MONTHS[peak]} runs ${Math.round((f.month[peak] - 1) * 100)}% above an ordinary month.`);
  if (f.month[slow] <= 0.8) notes.push(`${MONTHS[slow]} runs ${Math.round((1 - f.month[slow]) * 100)}% below an ordinary month.`);
  const heavyW = f.week.indexOf(Math.max(...f.week));
  if (f.week[heavyW] >= 1.15) notes.push(`The ${WEEK_NAMES[heavyW]} of a month runs ${Math.round((f.week[heavyW] - 1) * 100)}% heavier.`);
  if (longW > 0 && recentW / longW >= 1.3) notes.push(`The last ${p.config.recentWeeks} weeks ran ${Math.round((recentW / longW - 1) * 100)}% above the year.`);
  if (longW > 0 && recentW / longW <= 0.7) notes.push(`The last ${p.config.recentWeeks} weeks ran ${Math.round((1 - recentW / longW) * 100)}% below the year.`);
  if (activeWeekShare < 0.3) notes.push("Used in bursts: most weeks have no use at all.");

  const r1 = (x: number) => Math.round(x * 10) / 10;
  const src = rateFrom === "use" ? "production use" : "purchases";
  const seasonSrc = seasonFrom === rateFrom ? "" : `, seasonality from ${f.years} years of purchases`;
  const basis = `${r1(baseWeekly)}/week from ${weeks.length} weeks of ${src}${seasonSrc}; the next ${p.config.coverDays} days forecast ${r1(coverForecast)}.`;

  return {
    min,
    max,
    rateFrom,
    seasonFrom,
    coverForecast: r1(coverForecast),
    maxForecast: r1(maxForecast),
    baseDaily: Math.round(baseDaily * 1000) / 1000,
    weeklyLong: r1(longW),
    weeklyRecent: r1(recentW),
    weeksOfHistory: weeks.length,
    yearsOfSeason: f.years,
    activeWeekShare: Math.round(activeWeekShare * 100) / 100,
    monthFactor: f.month.map((x) => Math.round(x * 100) / 100),
    weekOfMonthFactor: f.week.map((x) => Math.round(x * 100) / 100),
    confidence,
    notes,
    basis,
  };
}

/** Applies the AI's adjustment, held inside ±`maxAdjustPercent`. */
export function adjusted(plan: { min: number; max: number }, factor: number | null, maxAdjustPercent: number): { min: number; max: number; factor: number } {
  const lo = 1 - maxAdjustPercent / 100;
  const hi = 1 + maxAdjustPercent / 100;
  const k = factor == null || !Number.isFinite(factor) ? 1 : clamp(factor, lo, hi);
  const min = roundUp(plan.min * k);
  return { min, max: Math.max(min, roundUp(plan.max * k)), factor: Math.round(k * 1000) / 1000 };
}

/** Months of a series as "YYYY-MM total" lines for the AI to read, newest last. */
export function monthlyTotals(points: DayQty[], todayIso: string, months: number): { month: string; qty: number }[] {
  const s = denseSeries(points, todayIso);
  const out = new Map<string, number>();
  for (let i = 0; i < s.qty.length; i++) {
    const { y, m } = fromDay(s.start + i);
    const k = `${y}-${String(m + 1).padStart(2, "0")}`;
    out.set(k, (out.get(k) ?? 0) + s.qty[i]);
  }
  return [...out.entries()].slice(-months).map(([month, qty]) => ({ month, qty: Math.round(qty * 10) / 10 }));
}
