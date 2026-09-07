import Link from "next/link";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import { endOfMonth, addMonths } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { ownerAlerts } from "@/lib/engines/expense-fraud";
import { topAndBottom } from "@/lib/engines/sales-roi";
import {
  customerCosts,
  expenseBreakdown,
  expenseTrend,
  salesmanRoi,
} from "@/lib/services/expense-roi-service";
import { listExceptions } from "@/lib/services/expense-service";
import { narrateExceptions } from "@/lib/services/expense-narrator";
import { Callout, EmptyState, Td, Th, Tr } from "@/components/ui/primitives";
import { Section } from "../parts";

export const metadata = { title: "Field cost & exceptions - Reports - MahekOne" };

const km = (metres: number) => `${Math.round(metres / 1000).toLocaleString("en-IN")} km`;
const pct = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toFixed(1)}%`);
const monthName = (period: string) =>
  new Date(`${period}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

/**
 * §M — what the field costs, and the few things about it that need somebody.
 *
 * **Every figure here is revenue, not margin**, and the screen says so where
 * nobody can miss it rather than in a footnote. MahekOne holds no product
 * costs by design, so an expense-to-sales ratio is turnover against spending —
 * useful, and not the profit figure the words "return" would imply.
 *
 * **The exception list is deliberately short.** Requirement 69 asks for "only
 * important exceptions requiring attention", and that is a rule about what is
 * LEFT OUT: `ownerAlerts` drops every info-level note, because a dashboard
 * listing all of them is one nobody opens twice and the finding that mattered
 * ends up on page three of it. The manager's full worklist is a click away.
 *
 * **The trend reads the snapshot, never the ledger.** A month rebuilt live
 * restates itself every time an old claim is corrected, so the shape of the
 * year would change under the owner with nothing having happened. A month with
 * no snapshot is absent rather than drawn as zero — before the table existed
 * there is no honest figure, and a zero would show a cost reduction that never
 * occurred.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : now.slice(0, 7);
  const from = `${month}-01`;
  const to = endOfMonth(month);

  const config = await getConfig();
  const [breakdown, people, costs, exceptions, trend] = await Promise.all([
    expenseBreakdown(from, to),
    salesmanRoi(from, to),
    customerCosts(from, to),
    listExceptions({ openOnly: true, limit: 200 }),
    expenseTrend(config["expenses.trendMonths"]),
  ]);

  /* Requirement 71. The findings are arithmetic; only the sentence is the AI,
     and the screen is complete without it — see `expense-narrator.ts`. */
  const narration = await narrateExceptions(exceptions, {
    month: monthName(month),
    totalPaise: Number(breakdown.totalPaise),
    salesmen: people.length,
  });

  const revenue = people.reduce((n, p) => n + Number(p.revenuePaise), 0);
  const cost = people.reduce((n, p) => n + p.cost.totalPaise, 0);
  const alerts = ownerAlerts(
    exceptions.map((e) => ({
      kind: e.kind as never,
      severity: e.severity as "info" | "warn" | "block_route",
      message: `${e.userName}${e.day ? ` · ${e.day}` : ""} — ${e.message}`,
      detail: {},
    })),
    12,
  );

  const perKm = topAndBottom(people, (p) => p.perKm.value, 3);
  const efficiency = topAndBottom(
    people,
    (p) => (p.expenseRatioBps.value === null ? null : -p.expenseRatioBps.value),
    3,
  );

  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const trendMax = Math.max(1, ...trend.map((t) => t.totalPaise));

  return (
    <div className="p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Field cost and exceptions</h1>
          <p className="mt-1 text-[13px] text-muted">
            What the sales team cost in {monthName(month)}, against what it brought in.
          </p>
        </div>
        <div className="flex gap-2 text-[13px]">
          <Link href={`/reports/expenses?month=${prev}`} className="text-muted no-underline">
            ← {monthName(prev)}
          </Link>
          <Link href={`/reports/expenses?month=${next}`} className="text-muted no-underline">
            {monthName(next)} →
          </Link>
        </div>
      </div>

      <Callout tone="brand">
        These are <strong>revenue</strong> ratios, not profit ratios. MahekOne holds no product
        costs, so no margin can be worked out — inventing one would put a believable wrong number
        on the screen where a wrong number does the most damage.
      </Callout>

      {breakdown.awaitingPaise > 0 ? (
        <Callout tone="warn">
          {money(breakdown.awaitingPaise)} has been claimed and not yet decided. Cost counts
          approved money only, so this month reads cheaper than it was until those are settled.
        </Callout>
      ) : null}

      {/* §M66 and §M67 — the total, and what it was made of. */}
      <Section title="What the month cost" subtitle="Approved expenses only.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Total", value: breakdown.totalPaise, strong: true },
            { label: "Travel", value: breakdown.travelPaise },
            { label: "Food", value: breakdown.foodPaise },
            { label: "Hotel", value: breakdown.lodgingPaise },
            { label: "Local transport", value: breakdown.localTransportPaise },
            { label: "Other", value: breakdown.otherPaise },
          ].map((m) => (
            <div key={m.label} className="rounded-[6px] border border-line px-3 py-2.5">
              <div className="text-[11px] tracking-[0.04em] text-muted uppercase">{m.label}</div>
              <div className={m.strong ? "text-[20px] font-semibold text-ink" : "text-[17px] text-ink"}>
                {money(Number(m.value))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-[13px] text-muted">
          Against {money(revenue)} of approved orders —{" "}
          {revenue > 0 ? pct(Math.round((cost / revenue) * 10_000)) : "no sales to compare against"}
          {revenue > 0 ? " of turnover, counting salary" : ""}.
        </div>
      </Section>

      {/* §M69 — only what needs somebody. */}
      <Section
        title="Needs your attention"
        subtitle="Notes are left out on purpose — a list of everything is a list nobody reads twice."
        actions={
          <Link href="/sales/exceptions" className="text-[13px] text-muted no-underline">
            The full worklist →
          </Link>
        }
      >
        {narration.text ? (
          <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3.5 py-3">
            <div className="mb-1 text-[11px] tracking-[0.04em] text-muted uppercase">
              In short — written by a model, from the findings below
            </div>
            <p className="text-[13px] leading-[19px] text-body">{narration.text}</p>
          </div>
        ) : narration.unavailableReason && alerts.length ? (
          <p className="mb-3 text-[12px] text-muted">{narration.unavailableReason}</p>
        ) : null}

        {alerts.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            body={
              exceptions.length
                ? `${exceptions.length} note${exceptions.length === 1 ? "" : "s"} were raised and none of them needs a decision.`
                : "No claim this month was outside policy or unlike what the person usually spends."
            }
          />
        ) : (
          <ul className="space-y-2">
            {alerts.map((a, i) => (
              <li key={i} className="flex items-start gap-2.5 text-[13px]">
                <span
                  className={
                    a.severity === "block_route"
                      ? "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
                      : "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
                  }
                />
                <span className="text-body">{a.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* §M68 and §M70 — comparison, and the two ends of it. */}
      <Section
        title="By salesman"
        subtitle="Sales per kilometre is the productivity figure; expense to sales is the efficiency one."
      >
        {people.length === 0 ? (
          <EmptyState
            title="Nothing to compare"
            body="This reads approved expense days and counting orders. A month with none has nothing to divide."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Salesman</Th>
                    <Th align="right">Revenue</Th>
                    <Th align="right">Distance</Th>
                    <Th align="right">Visits</Th>
                    <Th align="right">New customers</Th>
                    <Th align="right">Cost</Th>
                    <Th align="right">Sales / km</Th>
                    <Th align="right">Expense / sales</Th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <Tr key={p.userId}>
                      <Td>{p.name}</Td>
                      <Td align="right">{money(Number(p.revenuePaise))}</Td>
                      <Td align="right">
                        {p.metres > 0 ? km(p.metres) : <span className="text-muted">none</span>}
                      </Td>
                      <Td align="right">{p.visitCount}</Td>
                      <Td align="right">{p.newCustomerCount}</Td>
                      <Td align="right">
                        {money(p.cost.totalPaise)}
                        {p.cost.salaryMissing ? (
                          <span className="block text-[12px] text-warn-ink">no salary on file</span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        {p.perKm.value === null ? (
                          <span className="text-muted" title={p.perKm.reason ?? undefined}>
                            —
                          </span>
                        ) : (
                          money(Math.round(p.perKm.value))
                        )}
                      </Td>
                      <Td align="right">
                        {p.expenseRatioBps.value === null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          pct(p.expenseRatioBps.value)
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[6px] border border-line px-3 py-2.5 text-[13px]">
                <div className="mb-1 text-[11px] tracking-[0.04em] text-muted uppercase">
                  Most sales per kilometre
                </div>
                {perKm.top.map((p) => (
                  <div key={p.userId}>
                    {p.name} — {money(Math.round(p.perKm.value!))} a km
                  </div>
                ))}
                {perKm.bottom.length ? (
                  <div className="mt-2 text-muted">
                    Least: {perKm.bottom.map((p) => p.name).join(", ")}
                  </div>
                ) : null}
                {/* Somebody the question cannot be asked of is named, not ranked
                    last — a league table built out of missing data is an
                    accusation. */}
                {perKm.unmeasurable.length ? (
                  <div className="mt-2 text-muted">
                    No distance recorded, so not comparable:{" "}
                    {perKm.unmeasurable.map((p) => p.name).join(", ")}
                  </div>
                ) : null}
              </div>
              <div className="rounded-[6px] border border-line px-3 py-2.5 text-[13px]">
                <div className="mb-1 text-[11px] tracking-[0.04em] text-muted uppercase">
                  Lowest expense against sales
                </div>
                {efficiency.top.map((p) => (
                  <div key={p.userId}>
                    {p.name} — {pct(p.expenseRatioBps.value)}
                  </div>
                ))}
                {efficiency.unmeasurable.length ? (
                  <div className="mt-2 text-muted">
                    Nothing sold, so not comparable:{" "}
                    {efficiency.unmeasurable.map((p) => p.name).join(", ")}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </Section>

      {/* §L62–65 — and the two costs are drawn apart, never summed into one. */}
      <Section
        title="What a customer costs"
        subtitle="Winning one and keeping one are separate figures and stay separate — mixing them flatters whichever needs flattering."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-[6px] border border-line px-3 py-2.5">
            <div className="text-[11px] tracking-[0.04em] text-muted uppercase">
              Cost of a new customer
            </div>
            <div className="text-[17px] text-ink">
              {costs.acquisition.perCustomerPaise === null
                ? "—"
                : money(costs.acquisition.perCustomerPaise)}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {costs.acquisition.reason ??
                `${money(costs.acquisition.costPaise)} over ${costs.acquisition.newCustomers} won`}
            </div>
          </div>
          <div className="rounded-[6px] border border-line px-3 py-2.5">
            <div className="text-[11px] tracking-[0.04em] text-muted uppercase">
              Cost of servicing one
            </div>
            <div className="text-[17px] text-ink">
              {costs.servicing.perCustomerPaise === null
                ? "—"
                : money(costs.servicing.perCustomerPaise)}
            </div>
            <div className="mt-1 text-[12px] text-muted">
              {costs.servicing.reason ??
                `${money(costs.servicing.costPaise)} over ${costs.servicing.customersServed} served`}
            </div>
          </div>
          <div className="rounded-[6px] border border-line px-3 py-2.5">
            <div className="text-[11px] tracking-[0.04em] text-muted uppercase">
              Against no customer
            </div>
            <div className="text-[17px] text-ink">{money(costs.unattributedPaise)}</div>
            <div className="mt-1 text-[12px] text-muted">
              Counted in neither. A figure nobody can account for is worse than one that says why.
            </div>
          </div>
        </div>
      </Section>

      {/* §M72 — from the snapshot, and honest about months it has none for. */}
      <Section
        title="The last months"
        subtitle="Frozen at the end of each month, so correcting an old claim does not redraw a chart you already decided from."
      >
        {trend.length === 0 ? (
          <EmptyState
            title="We cannot say yet"
            body="The trend is written by the nightly pass, one month at a time, and it cannot be worked out backwards — a month before this existed has no honest figure, and drawing a zero would show a fall that never happened."
          />
        ) : (
          <>
            {trend.length < 3 ? (
              <Callout tone="warn">
                Only {trend.length} month{trend.length === 1 ? "" : "s"} recorded so far. It fills
                in one month at a time and cannot be backfilled.
              </Callout>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th align="right">Total cost</Th>
                    <Th>Shape</Th>
                    <Th align="right">Revenue</Th>
                    <Th align="right">Expense / sales</Th>
                    <Th align="right">Distance</Th>
                    <Th align="right">Salesmen</Th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((t) => (
                    <Tr key={t.period}>
                      <Td>{monthName(t.period)}</Td>
                      <Td align="right">{money(t.totalPaise)}</Td>
                      <Td>
                        {/* A bar rather than a chart library: one number per
                            month over twelve months does not need a dependency,
                            and a width is readable at a glance. */}
                        <span
                          className="inline-block h-2 rounded-[2px] bg-brand align-middle"
                          style={{ width: `${Math.round((t.totalPaise / trendMax) * 100)}%`, minWidth: 2 }}
                          title={money(t.totalPaise)}
                        />
                      </Td>
                      <Td align="right">{money(t.revenuePaise)}</Td>
                      <Td align="right">{pct(t.expenseRatioBps)}</Td>
                      <Td align="right">{t.metres > 0 ? km(t.metres) : "—"}</Td>
                      <Td align="right">{t.salesmanCount}</Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
