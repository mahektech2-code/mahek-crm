import { requireUser } from "@/lib/auth";
import { MonthNav, monthName } from "@/components/ui/month-nav";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import { BP, focusLines } from "@/lib/engines/performance";
import { readingsForPeriod } from "@/lib/services/performance-service";
import {
  Callout,
  Card,
  EmptyState,
  MetricStrip,
  PageHeader,
  Progress,
  SectionLabel,
} from "@/components/ui/primitives";

export const metadata = { title: "My performance - MahekOne CRM" };

/**
 * A person's own month.
 *
 * WHY THIS IS IN THE CRM AT ALL. Credit for a customer falls through: the
 * salesperson on the account, and where there is none, the back office person
 * who works it. In this company that second case is a large part of the book,
 * so telecallers carry real targets — and telecallers are redirected out of
 * `/sales` by its layout. Without this screen they would be measured against a
 * number they had no way to read.
 *
 * It shows ONE person, always the signed-in one. There is no scope switch and
 * no other-person parameter: a manager comparing people has the Sales
 * Dashboard, and giving this screen an id would make it a way for anybody to
 * read anybody's appraisal.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const now = await today();
  const period = /^\d{4}-\d{2}$/.test(params.period ?? "")
    ? params.period!
    : now.slice(0, 7);

  const [reading] = await readingsForPeriod(period, now, { userIds: [user.id] });

  if (!reading) {
    return (
      <div className="p-6">
        <PageHeader title="My performance" subtitle={monthName(period)} />
        <EmptyState
          title="Nothing to show for this month"
          body="No target has been published for you, and nothing has been sold against a customer you carry. If you expected a target here, your manager sets it on the Sales Dashboard."
        />
      </div>
    );
  }

  const by = (k: string) => reading.score.components.find((c) => c.key === k);
  const revenue = by("revenue");
  const volume = by("volume");
  const focus = focusLines(reading.score, reading.mix, now);

  return (
    <div className="p-6">
      <PageHeader
        title="My performance"
        subtitle={`${monthName(period)} — ${reading.workingDaysElapsed} of ${reading.workingDaysTotal} working days gone`}
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <MonthNav month={period} hrefFor={(m) => `/crm/performance?period=${m}`} />
          </div>
        }
      />

      {!reading.hasTarget ? (
        <Callout tone="brand">
          <strong className="font-medium">
            No target has been set for you this month.
          </strong>{" "}
          What is below is what you have actually done. There is no score,
          because a score needs something to have been asked for — and a
          percentage against a target nobody set would be a number this screen
          invented.
        </Callout>
      ) : null}

      {reading.hasTarget ? (
        <MetricStrip
          metrics={[
            {
              label: "Overall",
              value: `${(reading.score.totalBp / 100).toFixed(1)} / 100`,
              sub: reading.rating,
              tone:
                reading.score.totalBp >= 8000
                  ? "success"
                  : reading.score.totalBp < 6000
                    ? "danger"
                    : "ink",
            },
            {
              label: "Revenue",
              value: money(reading.actuals.revenuePaise),
              sub: targetSub(revenue?.target ?? null, money),
            },
            {
              label: "Volume",
              value: litres(reading.actuals.millilitres),
              sub: targetSub(volume?.target ?? null, litres),
            },
            {
              label: "New customers",
              value: String(reading.actuals.newCustomers),
              sub: targetSub(by("newCustomers")?.target ?? null, String),
            },
            {
              label: "Collected",
              value: money(reading.actuals.collectionPaise),
              sub: targetSub(by("collection")?.target ?? null, money),
            },
          ]}
        />
      ) : null}

      {/* Where am I behind, and what do I do about it — §36 of the brief, and
          the only question this screen exists to answer. It is first on the
          page because everything below it is the working-out. */}
      {focus.length ? (
        <Card className="mb-4 px-5 py-4">
          <SectionLabel>What is short</SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {focus.slice(0, 5).map((line) => (
              <li key={line.message} className="text-[14px] leading-5 text-ink">
                {line.message}
              </li>
            ))}
          </ul>
          {reading.revenueForecast.perRemainingDay !== null ? (
            <p className="mt-3 text-[13px] text-muted">
              {money(reading.revenueForecast.perRemainingDay)} a day over the{" "}
              {reading.revenueForecast.workingDaysRemaining} working days left would
              reach the revenue target.
              {reading.revenueForecast.projectedAchievementBp !== null
                ? ` At the rate so far the month lands at ${(reading.revenueForecast.projectedAchievementBp / 100).toFixed(0)}%.`
                : ""}
            </p>
          ) : null}
        </Card>
      ) : null}

      {reading.hasTarget && reading.mix.categories.length ? (
        <Card className="mb-4 px-5 py-4">
          <SectionLabel>Product mix</SectionLabel>
          <p className="mt-1 mb-3 text-[13px] text-muted">
            Share of what you sold this month, by value. Shown in litres beside it,
            which is what a customer orders in.
          </p>
          <div className="space-y-3">
            {reading.mix.categories.map((c) => (
              <div key={c.categoryId}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] text-ink">{c.name}</span>
                  <span className="text-[13px] text-muted tabular-nums">
                    {(c.actualBp / 100).toFixed(1)}% of {(c.targetBp / 100).toFixed(0)}%
                    {c.millilitres ? ` · ${litres(c.millilitres)}` : ""}
                  </span>
                </div>
                <Progress
                  className="mt-1.5"
                  value={c.targetBp ? (c.actualBp / c.targetBp) * 100 : 0}
                  tone={
                    c.status === "below-minimum"
                      ? "danger"
                      : c.status === "below-target"
                        ? "warn"
                        : "success"
                  }
                />
              </div>
            ))}
          </div>
          {reading.unmatchedPaise ? (
            <p className="mt-3 text-[12px] text-muted">
              {money(reading.unmatchedPaise)} of this month is on products that could
              not be matched to the catalogue. It counts as revenue in full and is
              inside the shares above, but it adds no litres.
            </p>
          ) : null}
        </Card>
      ) : null}

      {reading.hasTarget ? (
        <Card className="mb-4 px-5 py-4">
          <SectionLabel>How the score is made up</SectionLabel>
          <table className="mt-2 w-full text-[13px]">
            <thead>
              <tr className="text-[11px] tracking-[0.04em] text-muted uppercase">
                <th className="py-1 text-left font-medium">Measured on</th>
                <th className="py-1 text-right font-medium">Achieved</th>
                <th className="py-1 text-right font-medium">Weight</th>
                <th className="py-1 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody>
              {reading.score.components.map((c) => (
                <tr key={c.key} className="border-t border-divider">
                  <td className="py-1.5 text-body">{COMPONENT_LABELS[c.key]}</td>
                  <td className="py-1.5 text-right text-ink tabular-nums">
                    {c.achievementBp === null ? (
                      <span className="text-muted">not asked</span>
                    ) : (
                      `${(c.achievementBp / 100).toFixed(0)}%`
                    )}
                  </td>
                  <td className="py-1.5 text-right text-muted tabular-nums">
                    {c.achievementBp === null
                      ? "—"
                      : c.effectiveWeight.toFixed(0)}
                  </td>
                  <td className="py-1.5 text-right text-ink tabular-nums">
                    {c.achievementBp === null ? "—" : (c.pointsBp / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-line font-medium">
                <td className="py-1.5 text-ink">Total</td>
                <td />
                <td />
                <td className="py-1.5 text-right text-ink tabular-nums">
                  {(reading.score.totalBp / 100).toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
          {reading.score.untargeted.length ? (
            <p className="mt-3 text-[12px] text-muted">
              Nothing was asked of you on{" "}
              {reading.score.untargeted
                .map((k) => COMPONENT_LABELS[k].toLowerCase())
                .join(", ")}
              , so {reading.score.untargeted.length === 1 ? "it is" : "they are"} left
              out and the weight is shared among the rest. The score is still out of
              100.
            </p>
          ) : null}
          {revenue?.achievementBp !== null &&
          revenue !== undefined &&
          volume?.achievementBp !== null &&
          volume !== undefined &&
          revenue.achievementBp! >= BP &&
          volume.achievementBp! < BP ? (
            <p className="mt-2 text-[12px] text-warn-ink">
              Revenue is at target and volume is not. Prices went up more than the
              quantity you sold — worth knowing before the month is read as a good one.
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

const COMPONENT_LABELS: Record<string, string> = {
  revenue: "Revenue",
  volume: "Volume",
  mix: "Product mix",
  newCustomers: "New customers",
  collection: "Collection",
  activity: "Visits and calls",
};

function targetSub(target: number | null, render: (n: number) => string) {
  return target ? `of ${render(target)}` : undefined;
}

function litres(ml: number): string {
  if (!ml) return "0 L";
  return `${Math.round(ml / 1000).toLocaleString("en-IN")} L`;
}

