"use client";

import * as React from "react";
import Link from "next/link";
import { BodyPortal } from "@/components/ui/body-portal";
import { useEscape } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { Pill } from "@/components/console/parts";
import { money, moneyShort } from "@/lib/format";
import { bpPercent, collectionLine } from "@/lib/performance-labels";
import {
  RANGE_PRESETS,
  presetOf,
  presetRange,
  rangeLabel,
  wholeMonthOf,
  type DayRange,
} from "@/lib/performance-range";
import { ratingTone } from "./rating-tone";
import type { PersonPerformance } from "@/lib/services/performance-service";

/* ---------------------------------------------------------------------------
 * ONE PERSON'S PERFORMANCE, IN DETAIL — opened from their name on the
 * Performance table.
 *
 * The table answers "how is the team doing this month"; this answers "why is
 * this person at 28.8" — what each of the six components earned, what was
 * asked, where the month is heading, which shops it came from — over any
 * range, not only the month the table shows.
 *
 * Every figure comes from `/api/sales/performance`, which scores the range
 * with the same computation the salesman's own phone uses, so the number in
 * this modal and the number on his handset are one figure. A whole month is
 * also exactly the table's figure.
 * ------------------------------------------------------------------------- */

type Answer =
  | { key: string; ok: true; reading: PersonPerformance }
  | { key: string; ok: false; error: string };

const COMPONENT_LABEL: Record<string, string> = {
  revenue: "Revenue excl. GST",
  volume: "Volume",
  mix: "Product mix",
  newCustomers: "New customers",
  collection: "Collection",
  activity: "Activity (tasks done)",
};

export function PersonPerformanceButton({
  userId,
  name,
  month,
  today,
}: {
  userId: string;
  name: string;
  /** The month the table is showing, `YYYY-MM` — what the modal opens on. */
  month: string;
  today: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Open ${name}'s performance in detail`}
        className="max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-sm font-medium text-ink decoration-from-font underline-offset-2 hover:text-brand hover:underline"
      >
        {name}
      </button>
      {open ? (
        <PersonPerformanceModal
          userId={userId}
          name={name}
          initial={{ from: `${month}-01`, to: endOfMonth(month) }}
          today={today}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function endOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

function PersonPerformanceModal({
  userId,
  name,
  initial,
  today,
  onClose,
}: {
  userId: string;
  name: string;
  initial: DayRange;
  today: string;
  onClose: () => void;
}) {
  useEscape(onClose);
  const [range, setRange] = React.useState<DayRange>(initial);
  const [draft, setDraft] = React.useState<DayRange>(initial);
  const [answer, setAnswer] = React.useState<Answer | null>(null);
  const key = `${range.from}..${range.to}`;

  React.useEffect(() => {
    let alive = true;
    const q = new URLSearchParams({ userId, from: range.from, to: range.to });
    fetch(`/api/sales/performance?${q}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | { ok: true; reading: PersonPerformance }
          | { ok: false; error: string }
          | null;
        if (!alive) return;
        if (body?.ok) setAnswer({ key, ok: true, reading: body.reading });
        else setAnswer({ key, ok: false, error: body?.error ?? "MahekOne could not work that out just now." });
      })
      .catch(() => {
        if (alive) setAnswer({ key, ok: false, error: "MahekOne could not be reached. Check the connection and try again." });
      });
    return () => {
      alive = false;
    };
  }, [userId, range.from, range.to, key]);

  const current = answer?.key === key ? answer : null;
  const reading = current?.ok ? current.reading : null;
  const preset = presetOf(range, today);
  const pick = (r: DayRange) => {
    setRange(r);
    setDraft(r);
  };

  return (
    <BodyPortal>
      <div
        onClick={onClose}
        className="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(22,22,22,0.35)] p-4"
        role="dialog"
        aria-modal="true"
        aria-label={`${name} — performance`}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[92vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-[6px] bg-surface whitespace-normal shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
        >
          {/* Head: who, the score, the rating. */}
          <div className="flex items-start gap-4 border-b border-divider px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="text-lg font-semibold text-ink">{name}</div>
              <div className="mt-0.5 text-[13px] text-muted">
                {rangeLabel(range)}
                {reading?.ordersCount !== undefined && reading
                  ? ` · ${reading.ordersCount} ${reading.ordersCount === 1 ? "order" : "orders"} counted`
                  : ""}
              </div>
            </div>
            {reading ? (
              reading.hasTarget && reading.totalScoreBp !== null ? (
                <div className="text-right">
                  <div className="flex items-baseline justify-end gap-1.5">
                    <span className={cx("text-[28px] leading-8 font-semibold tabular-nums", scoreInk(reading.totalScoreBp))}>
                      {(reading.totalScoreBp / 100).toFixed(1)}
                    </span>
                    <span className="text-[13px] text-muted">/ 100</span>
                  </div>
                  {reading.rating ? <Pill tone={ratingTone(reading.totalScoreBp)}>{reading.rating}</Pill> : null}
                </div>
              ) : (
                <div className="text-right text-[13px] text-muted">No target set — nothing to score against</div>
              )
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mt-1 -mr-1 flex size-8 flex-none cursor-pointer items-center justify-center rounded-[4px] border-0 bg-transparent text-xl text-muted hover:bg-canvas hover:text-ink"
            >
              ×
            </button>
          </div>

          {/* The period: presets, and any two days. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-divider bg-canvas px-5 py-2.5">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => pick(presetRange(p.key, today))}
                className={cx(
                  "cursor-pointer rounded-full border px-3 py-1 text-[13px]",
                  preset === p.key
                    ? "border-brand bg-brand-soft text-[#5223E0]"
                    : "border-line bg-surface text-body hover:border-brand",
                )}
              >
                {p.label}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-1.5 text-[13px] text-muted">
              <input
                type="date"
                value={draft.from}
                max={draft.to}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                className="rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px] text-ink"
                aria-label="From"
              />
              to
              <input
                type="date"
                value={draft.to}
                min={draft.from}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                className="rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px] text-ink"
                aria-label="To"
              />
              <button
                type="button"
                disabled={!draft.from || !draft.to || draft.from > draft.to || (draft.from === range.from && draft.to === range.to)}
                onClick={() => setRange(draft)}
                className="cursor-pointer rounded-[4px] border-0 bg-brand px-3 py-1.5 text-[13px] font-medium text-white disabled:cursor-default disabled:opacity-40"
              >
                Show
              </button>
            </span>
          </div>

          <div className="min-h-[240px] flex-1 overflow-y-auto px-5 py-4">
            {!current ? (
              <div className="py-16 text-center text-[13px] text-muted">Working it out…</div>
            ) : !current.ok ? (
              <div className="rounded-[6px] border border-danger-soft bg-danger-soft/40 px-4 py-3 text-[13px] text-danger">
                {current.error}
              </div>
            ) : (
              <Detail reading={current.reading} />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-divider px-5 py-3 text-[13px]">
            <Link href={`/sales/people/${userId}`}>Open their record</Link>
            <Link href={`/sales/targets?period=${(wholeMonthOf(range) ?? range.from.slice(0, 7))}`}>Set their target</Link>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-[4px] border border-line bg-surface px-3 py-1.5 text-body hover:bg-canvas"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </BodyPortal>
  );
}

/* ------------------------------------------------------------- the body */

function Detail({ reading: r }: { reading: PersonPerformance }) {
  const notes: string[] = [];
  if (r.monthsInRange > 1 || r.prorated) {
    notes.push(
      r.monthsTargeted === 0
        ? "No month in this range carried a published target."
        : `Scored against the targets of ${r.monthsTargeted} of the ${r.monthsInRange} ${r.monthsInRange === 1 ? "month" : "months"} in this range, added up` +
            (r.prorated ? " — a month only partly inside the range asks for that part of its target." : "."),
    );
  }
  if (r.hasTarget && r.untargeted.length) {
    notes.push(
      `No target for ${r.untargeted.map((k) => (COMPONENT_LABEL[k] ?? k).toLowerCase()).join(", ")}, so ${
        r.untargeted.length === 1 ? "it is" : "they are"
      } left out and the other parts count for more. The score is still out of 100.`,
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* The headline figures. */}
      <CardGrid min={150} gap="gap-px" className="overflow-hidden rounded-[6px] border border-line bg-line">
        <Tile label="Revenue excl. GST" value={money(r.revenueActualPaise)} sub={against(r.revenueTargetPaise, r.revenueAchievementBp, money)} />
        <Tile label="Volume" value={litres(r.volumeActualMl)} sub={against(r.volumeTargetMl, r.volumeAchievementBp, litres)} />
        <Tile
          label="Collection"
          value={bpPercent(r.collectionShareBp)}
          sub={
            (r.collectionTargetBp ? `target ${bpPercent(r.collectionTargetBp)} · ` : "") +
            collectionLine({ done: r.collectionActualPaise, base: r.collectionBasePaise }, moneyShort)
          }
        />
        <Tile label="New customers" value={String(r.newCustomerActual)} sub={r.newCustomerTarget ? `of ${r.newCustomerTarget} asked` : "no target"} />
        <Tile
          label="Tasks done"
          value={r.activityAssigned > 0 ? bpPercent(Math.round((r.activityActual / r.activityAssigned) * 10_000)) : "—"}
          sub={r.activityAssigned > 0 ? `${r.activityActual} of ${r.activityAssigned} tasks` : "no tasks were set"}
        />
      </CardGrid>

      {notes.length ? (
        <div className="flex flex-col gap-1 text-[13px] text-muted">
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      ) : null}

      {r.alerts.length ? (
        <Section title="Wants attention">
          <ul className="flex flex-col gap-1.5">
            {r.alerts.map((a) => (
              <li key={a.key} className="flex gap-2 text-[13px] text-warn-ink">
                <span aria-hidden>•</span>
                {a.message}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* How the score was built. */}
      <Section title="How the score is built">
        <div className="overflow-hidden rounded-[6px] border border-line">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead>
              <tr className="bg-canvas text-left text-[11px] tracking-[0.04em] text-muted uppercase">
                <th className="w-[30%] px-3 py-2 font-medium">Component</th>
                <th className="px-3 py-2 text-right font-medium">Achieved</th>
                <th className="px-3 py-2 text-right font-medium">Asked</th>
                <th className="w-[22%] px-3 py-2 font-medium">Achievement</th>
                <th className="px-3 py-2 text-right font-medium">Weight</th>
                <th className="px-3 py-2 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody>
              {r.components.map((c) => {
                const out = componentFigures(c.key, r);
                const live = c.achievementBp !== null;
                return (
                  <tr key={c.key} className="border-t border-divider">
                    <td className="px-3 py-2 text-ink">{COMPONENT_LABEL[c.key] ?? c.key}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">{out.actual}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{live ? out.target : "not asked"}</td>
                    <td className="px-3 py-2">
                      {live ? <Bar bp={c.achievementBp!} /> : <span className="text-muted">left out</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {live ? `${c.effectiveWeight.toFixed(0)}%` : <s>{c.weight}%</s>}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums text-ink">
                      {live ? (c.pointsBp / 100).toFixed(1) : "—"}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-line bg-canvas">
                <td className="px-3 py-2 font-medium text-ink" colSpan={5}>
                  Score out of 100
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink">
                  {r.hasTarget && r.totalScoreBp !== null ? (r.totalScoreBp / 100).toFixed(1) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[12px] text-muted">
          Points are achievement (capped) times weight. A component nobody set a target for is left out and its weight
          is shared among the rest.
        </p>
      </Section>

      {/* Where the month is heading. */}
      {r.revenueForecast && r.workingDays ? (
        <Section title="Where the month is heading">
          <CardGrid min={220} gap="gap-3">
            <ForecastCard
              label="Revenue"
              f={r.revenueForecast}
              render={money}
              target={r.revenueTargetPaise}
              days={r.workingDays}
            />
            {r.volumeForecast ? (
              <ForecastCard label="Volume" f={r.volumeForecast} render={litres} target={r.volumeTargetMl} days={r.workingDays} />
            ) : null}
          </CardGrid>
        </Section>
      ) : null}

      {/* Day by day, or month by month. */}
      {r.daily && r.daily.length > 1 ? (
        <Section title="Revenue, day by day">
          <DailyChart daily={r.daily} target={r.revenueTargetPaise} />
        </Section>
      ) : null}
      {r.months.length > 1 ? (
        <Section title="Month by month">
          <MonthTable months={r.months} />
        </Section>
      ) : null}

      <CardGrid min={320} gap="gap-5">
        {r.categories.length ? (
          <Section title="Product mix">
            <div className="flex flex-col gap-2.5">
              {r.categories.map((c) => (
                <div key={c.name}>
                  <div className="flex items-baseline justify-between gap-2 text-[13px]">
                    <span className="truncate text-ink">{c.name}</span>
                    <span className="flex-none tabular-nums text-muted">
                      <span className={mixInk(c.status)}>{(c.actualBp / 100).toFixed(1)}%</span> of value · target{" "}
                      {(c.targetBp / 100).toFixed(0)}%, minimum {(c.minimumBp / 100).toFixed(0)}%
                    </span>
                  </div>
                  <MixBar actual={c.actualBp} target={c.targetBp} minimum={c.minimumBp} status={c.status} />
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        <Section title="Where the revenue came from">
          {r.topCustomers.length ? (
            <div className="overflow-hidden rounded-[6px] border border-line">
              {r.topCustomers.map((c, i) => (
                <div key={c.id} className={cx("flex items-center gap-3 px-3 py-2 text-[13px]", i > 0 && "border-t border-divider")}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{c.name}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {c.orders} {c.orders === 1 ? "order" : "orders"}
                      {c.city ? ` · ${c.city}` : ""}
                    </span>
                  </span>
                  <span className="flex-none text-right tabular-nums text-ink">
                    {money(c.revenuePaise)}
                    {r.revenueActualPaise > 0 ? (
                      <span className="block text-[11px] text-muted">
                        {((c.revenuePaise / r.revenueActualPaise) * 100).toFixed(0)}% of theirs
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-muted">No accepted orders credited to them in this range.</p>
          )}
        </Section>
      </CardGrid>

      {r.unmatchedRevenuePaise > 0 ? (
        <p className="text-[12px] text-muted">
          {money(r.unmatchedRevenuePaise)} of revenue is on products the catalogue could not match, so it carries no litres.
        </p>
      ) : null}
    </div>
  );
}

function componentFigures(key: string, r: PersonPerformance): { actual: string; target: string } {
  switch (key) {
    case "revenue":
      return { actual: moneyShort(r.revenueActualPaise), target: r.revenueTargetPaise ? moneyShort(r.revenueTargetPaise) : "—" };
    case "volume":
      return { actual: litres(r.volumeActualMl), target: r.volumeTargetMl ? litres(r.volumeTargetMl) : "—" };
    case "mix":
      return { actual: bpPercent(r.mixAchievementBp), target: "the bands set" };
    case "newCustomers":
      return { actual: String(r.newCustomerActual), target: r.newCustomerTarget ? String(r.newCustomerTarget) : "—" };
    case "collection":
      /* Said as the share it is asked as — of what was overdue when the range opened. */
      return {
        actual: bpPercent(r.collectionShareBp),
        target: r.collectionTargetBp ? `${bpPercent(r.collectionTargetBp)} of overdue` : "—",
      };
    case "activity":
      /* A share of the tasks that fell due, like collection is of the debt. */
      return {
        actual:
          r.activityAssigned > 0
            ? `${bpPercent(Math.round((r.activityActual / r.activityAssigned) * 10_000))} (${r.activityActual} of ${r.activityAssigned})`
            : "no tasks",
        target:
          r.activityTarget && r.activityAssigned > 0
            ? `${bpPercent(Math.round((r.activityTarget / r.activityAssigned) * 10_000))} of tasks`
            : "—",
      };
    default:
      return { actual: "—", target: "—" };
  }
}

/* ------------------------------------------------------------- the parts */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface px-3.5 py-3">
      <div className="text-[11px] tracking-[0.04em] text-muted uppercase">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{value}</div>
      {sub ? <div className="text-[12px] text-muted">{sub}</div> : null}
    </div>
  );
}

function against(target: number | null, bp: number | null, render: (n: number) => string): string {
  if (!target) return "no target";
  return `${bpPercent(bp)} of ${render(target)}`;
}

function Bar({ bp }: { bp: number }) {
  const w = Math.max(0, Math.min(100, bp / 100));
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-divider">
        <span
          className={cx("block h-full rounded-full", bp >= 10_000 ? "bg-success" : bp >= 6_000 ? "bg-warn" : "bg-danger")}
          style={{ width: `${w}%` }}
        />
      </span>
      <span className="w-11 flex-none text-right tabular-nums text-ink">{bpPercent(bp)}</span>
    </span>
  );
}

function MixBar({ actual, target, minimum, status }: { actual: number; target: number; minimum: number; status: string }) {
  const scale = Math.max(actual, target, minimum, 1) * 1.15;
  const at = (bp: number) => `${Math.min(100, (bp / scale) * 100)}%`;
  return (
    <span className="relative mt-1 block h-2 overflow-hidden rounded-full bg-divider">
      <span
        className={cx("absolute inset-y-0 left-0 rounded-full", status === "below-minimum" ? "bg-danger" : status === "below-target" ? "bg-warn" : "bg-success")}
        style={{ width: at(actual) }}
      />
      <span className="absolute inset-y-0 w-px bg-ink/50" style={{ left: at(minimum) }} title="Minimum" />
      <span className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: at(target) }} title="Target" />
    </span>
  );
}

function ForecastCard({
  label,
  f,
  render,
  target,
  days,
}: {
  label: string;
  f: NonNullable<PersonPerformance["revenueForecast"]>;
  render: (n: number) => string;
  target: number | null;
  days: { elapsed: number; total: number };
}) {
  return (
    <div className="rounded-[6px] border border-line px-3.5 py-3 text-[13px]">
      <div className="text-[11px] tracking-[0.04em] text-muted uppercase">{label}</div>
      {f.projected === null ? (
        <p className="mt-1 text-muted">Too early to project — no working day of this month is complete yet.</p>
      ) : (
        <>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{render(f.projected)}</div>
          <div className="text-muted">
            projected at month end{target ? ` · ${bpPercent(f.projectedAchievementBp)} of ${render(target)}` : ""}
          </div>
        </>
      )}
      <div className="mt-1.5 text-muted">
        {days.elapsed} of {days.total} working days gone
        {f.shortfall !== null && f.perRemainingDay !== null
          ? ` · ${render(f.perRemainingDay)} a day needed for the rest`
          : f.shortfall === null && target
            ? " · target met"
            : ""}
      </div>
    </div>
  );
}

/** Cumulative revenue by day, against a straight line to the target. */
function DailyChart({ daily, target }: { daily: { date: string; revenuePaise: number }[]; target: number | null }) {
  const W = 960;
  const H = 150;
  const pad = { l: 8, r: 8, t: 10, b: 20 };
  const points: number[] = [];
  for (const d of daily) points.push((points[points.length - 1] ?? 0) + d.revenuePaise);
  const run = points[points.length - 1] ?? 0;
  const top = Math.max(run, target ?? 0, 1);
  const x = (i: number) => pad.l + (i / Math.max(1, daily.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const line = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`;
  const maxDay = Math.max(...daily.map((d) => d.revenuePaise), 1);
  const barW = Math.max(1, (W - pad.l - pad.r) / daily.length - 2);
  const label = (iso: string) => `${+iso.slice(8, 10)}/${+iso.slice(5, 7)}`;
  return (
    <div className="rounded-[6px] border border-line px-3 py-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-[150px] w-full" preserveAspectRatio="none" role="img" aria-label="Revenue by day">
        {daily.map((d, i) => {
          const h = (d.revenuePaise / maxDay) * (H - pad.t - pad.b) * 0.45;
          return (
            <rect
              key={d.date}
              x={x(i) - barW / 2}
              y={y(0) - h}
              width={barW}
              height={h}
              className="fill-brand-soft"
            >
              <title>{`${d.date}: ${money(d.revenuePaise)}`}</title>
            </rect>
          );
        })}
        <path d={area} className="fill-brand/10" />
        <path d={line} fill="none" className="stroke-brand" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        {target ? (
          <line
            x1={x(0)}
            y1={y(0)}
            x2={x(daily.length - 1)}
            y2={y(target)}
            className="stroke-muted"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="flex justify-between text-[11px] text-muted">
        <span>{label(daily[0].date)}</span>
        <span>
          Running total {money(run)}
          {target ? ` · dashed line: steady pace to ${money(target)}` : ""}
        </span>
        <span>{label(daily[daily.length - 1].date)}</span>
      </div>
    </div>
  );
}

function MonthTable({ months }: { months: PersonPerformance["months"] }) {
  const top = Math.max(...months.map((m) => m.revenuePaise), 1);
  return (
    <div className="overflow-hidden rounded-[6px] border border-line">
      {months.map((m, i) => (
        <div key={m.period} className={cx("grid grid-cols-[90px_1fr_110px_90px_140px] items-center gap-3 px-3 py-2 text-[13px]", i > 0 && "border-t border-divider")}>
          <span className="text-ink">{rangeLabel({ from: `${m.period}-01`, to: endOfMonth(m.period) })}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-divider">
            <span className="block h-full rounded-full bg-brand" style={{ width: `${(m.revenuePaise / top) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums text-ink">{moneyShort(m.revenuePaise)}</span>
          <span className="text-right tabular-nums text-muted">{litres(m.millilitres)}</span>
          <span className="flex items-center justify-end gap-2">
            {m.hasTarget && m.totalScoreBp !== null ? (
              <>
                <span className="tabular-nums font-medium text-ink">{(m.totalScoreBp / 100).toFixed(1)}</span>
                {m.rating ? <Pill tone={ratingTone(m.totalScoreBp)}>{m.rating}</Pill> : null}
              </>
            ) : (
              <span className="text-[12px] text-muted">no target</span>
            )}
          </span>
        </div>
      ))}
      <p className="border-t border-divider bg-canvas px-3 py-1.5 text-[11px] text-muted">
        The month in progress is worked out now; earlier months as the nightly job last worked them out.
      </p>
    </div>
  );
}

function litres(ml: number): string {
  if (!ml) return "0 L";
  return `${Math.round(ml / 1000).toLocaleString("en-IN")} L`;
}

function mixInk(status: string): string {
  return status === "below-minimum" ? "text-danger" : status === "below-target" ? "text-warn-ink" : "text-success";
}

function scoreInk(bp: number): string {
  const s = bp / 100;
  return s >= 80 ? "text-success" : s >= 60 ? "text-warn-ink" : "text-danger";
}
