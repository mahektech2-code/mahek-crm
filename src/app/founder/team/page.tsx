import { money, moneyShort } from "@/lib/format";
import { today } from "@/lib/recompute";
import { BP } from "@/lib/engines/performance";
import { Badge, Card, PageHeader, Th, Td, Tr } from "@/components/ui/primitives";
import { MonthNav, monthName } from "@/components/ui/month-nav";
import { founderTeamPerformance } from "@/lib/services/founder-dashboard-service";

export const metadata = { title: "Team performance - Founder Dashboard - MahekOne" };

/**
 * Everybody scored, one list — the same reading `/sales/performance` shows a
 * manager for their own team, here with no `userIds` restriction, so it is
 * the whole company: telecallers and the field team together, ranked.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : now.slice(0, 7);

  const ranked = await founderTeamPerformance(month, now);

  return (
    <div className="p-6">
      <PageHeader
        title="Team performance"
        subtitle="Revenue, litres, product mix, new customers, collection and activity, scored out of 100 — the same reading each app's own screen shows."
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <MonthNav month={month} hrefFor={(m) => `/founder/team?month=${m}`} />
          </div>
        }
      />

      {ranked.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <div className="text-lg font-semibold text-ink">Nobody to score yet</div>
          <p className="mx-auto mt-1.5 max-w-[480px] text-[15px] text-muted">
            Nobody holds a published target for {monthName(month)} and nothing has been
            sold against a customer with a salesperson or a back office person.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th>Rank</Th>
                  <Th>Person</Th>
                  <Th align="right">Score</Th>
                  <Th>Rating</Th>
                  <Th align="right">Revenue</Th>
                  <Th align="right">Volume</Th>
                  <Th align="right">Mix</Th>
                  <Th align="right">New</Th>
                  <Th align="right">Collection</Th>
                  <Th align="right">Activity</Th>
                  <Th>Wants attention</Th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((r) => {
                  const by = (k: string) =>
                    r.score.components.find((c) => c.key === k)?.achievementBp ?? null;
                  const revenue = by("revenue");
                  const volume = by("volume");
                  const diverging =
                    revenue !== null && volume !== null && revenue >= BP && volume < BP;

                  return (
                    <Tr key={r.userId} className="hover:bg-canvas">
                      <Td className="tabular-nums text-muted">{r.rank ?? "—"}</Td>
                      <Td className="font-medium text-ink">{r.userName}</Td>
                      <Td align="right">
                        {r.hasTarget ? (
                          <span className="font-medium text-ink tabular-nums">
                            {(r.score.totalBp / 100).toFixed(1)}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                      <Td>
                        {r.hasTarget ? (
                          <Badge tone={ratingTone(r.score.totalBp)}>{r.rating}</Badge>
                        ) : (
                          <span className="text-[12px] text-muted" title="No published target for this month.">
                            no target set
                          </span>
                        )}
                      </Td>
                      <Td align="right">
                        <Achieved actual={money(r.actuals.revenuePaise)} bp={revenue} emphasise={diverging} />
                      </Td>
                      <Td align="right">
                        <Achieved actual={litres(r.actuals.millilitres)} bp={volume} emphasise={diverging} />
                      </Td>
                      <Td align="right">{pct(r.mix.achievementBp)}</Td>
                      <Td align="right">
                        <Achieved actual={String(r.actuals.newCustomers)} bp={by("newCustomers")} />
                      </Td>
                      <Td align="right">
                        <Achieved actual={moneyShort(r.actuals.collectionPaise)} bp={by("collection")} />
                      </Td>
                      <Td align="right">
                        <Achieved actual={String(r.actuals.activity)} bp={by("activity")} />
                      </Td>
                      <Td className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {r.alerts.length ? (
                          <span className="text-[12px] text-warn-ink" title={r.alerts.map((a) => a.message).join("\n")}>
                            {r.alerts[0].message}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="mt-3 max-w-[860px] text-[13px] text-pretty text-muted">
        A customer&rsquo;s figures count towards their salesperson, and where an account
        has none, towards the back office person who works it — one person per customer,
        so these rows add up to the company rather than past it. This is the whole
        roster, telecallers and the field team together; the Sales Dashboard&rsquo;s own
        Performance screen shows the same reading for the field team on its own.
      </p>
    </div>
  );
}

function Achieved({
  actual,
  bp,
  emphasise,
}: {
  actual: string;
  bp: number | null;
  emphasise?: boolean;
}) {
  return (
    <span className="tabular-nums">
      <span className="text-ink">{actual}</span>
      {bp === null ? null : (
        <span
          className={
            emphasise
              ? "ml-1.5 text-[12px] font-medium text-warn-ink"
              : bp >= BP
                ? "ml-1.5 text-[12px] text-success"
                : "ml-1.5 text-[12px] text-muted"
          }
        >
          {(bp / 100).toFixed(0)}%
        </span>
      )}
    </span>
  );
}

function pct(bp: number | null) {
  return bp === null ? (
    <span className="text-muted">—</span>
  ) : (
    <span className="tabular-nums text-ink">{(bp / 100).toFixed(0)}%</span>
  );
}

function litres(ml: number): string {
  if (!ml) return "0 L";
  return `${Math.round(ml / 1000).toLocaleString("en-IN")} L`;
}

function ratingTone(bp: number): "success" | "brand" | "warn" | "danger" {
  const score = bp / 100;
  if (score >= 90) return "success";
  if (score >= 80) return "brand";
  if (score >= 60) return "warn";
  return "danger";
}

