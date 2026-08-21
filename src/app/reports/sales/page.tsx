import { getConfig } from "@/lib/config/store";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import {
  REPORT_PERIOD_LABELS,
  comparableRange,
  sameRangeLastYear,
} from "@/lib/business-date";
import { billSize, changeInCount, frequency } from "@/lib/engines/owner-kpis";
import {
  filterOptions,
  salesFigures,
} from "@/lib/services/owner-dashboard-service";
import { Card, EmptyState, Td, Th, Tr } from "@/components/ui/primitives";
import { FilterBar } from "../filters";
import { ChangePill, Section, rangeLabel, readParams, type ReportQuery } from "../parts";

export const metadata = { title: "Bill size & frequency - Reports - MahekOne" };

/**
 * What an order is worth, and how often one comes.
 *
 * The two belong on one screen because they are the two halves of the same
 * sum: revenue is bill size times frequency times customers, and moving one of
 * them at the cost of another is the commonest way a month looks flat while
 * something real has changed underneath it.
 *
 * Three columns rather than two — this period, the one before, and the same
 * window a year ago — because §3 asks for it and because seasonality in a
 * paint-thinner book is real. A March compared only against February says
 * nothing about whether March was good.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<ReportQuery>;
}) {
  const params = await searchParams;
  const now = await today();
  const config = await getConfig();
  const { period, range, filters, custom } = readParams(params, now);

  const compared = comparableRange(range, period);
  const lastYear = sameRangeLastYear(range);

  const [nowFigures, beforeFigures, lastYearFigures, options] = await Promise.all([
    salesFigures(range, filters),
    salesFigures(compared, filters),
    salesFigures(lastYear, filters),
    filterOptions(),
  ]);

  const size = billSize(
    nowFigures.grossValuePaise,
    nowFigures.creditNotePaise,
    nowFigures.transactions,
  );
  const sizeBefore = billSize(
    beforeFigures.grossValuePaise,
    beforeFigures.creditNotePaise,
    beforeFigures.transactions,
  );
  const sizeLastYear = billSize(
    lastYearFigures.grossValuePaise,
    lastYearFigures.creditNotePaise,
    lastYearFigures.transactions,
  );

  const freq = frequency(nowFigures.transactions, nowFigures.ordersPerCustomer, config);
  const freqBefore = frequency(
    beforeFigures.transactions,
    beforeFigures.ordersPerCustomer,
    config,
  );
  const freqLastYear = frequency(
    lastYearFigures.transactions,
    lastYearFigures.ordersPerCustomer,
    config,
  );

  const rows: {
    label: string;
    now: string;
    before: string;
    lastYear: string;
    change: ReturnType<typeof changeInCount>;
  }[] = [
    {
      label: "Average bill size",
      now: size.averagePaise === null ? "—" : money(size.averagePaise),
      before: sizeBefore.averagePaise === null ? "—" : money(sizeBefore.averagePaise),
      lastYear:
        sizeLastYear.averagePaise === null ? "—" : money(sizeLastYear.averagePaise),
      change: changeInCount(size.averagePaise ?? 0, sizeBefore.averagePaise ?? 0),
    },
    {
      label: "Sales value (net of credit notes)",
      now: money(size.netValuePaise),
      before: money(sizeBefore.netValuePaise),
      lastYear: money(sizeLastYear.netValuePaise),
      change: changeInCount(size.netValuePaise, sizeBefore.netValuePaise),
    },
    {
      label: "Transactions",
      now: String(size.transactions),
      before: String(sizeBefore.transactions),
      lastYear: String(sizeLastYear.transactions),
      change: changeInCount(size.transactions, sizeBefore.transactions),
    },
    {
      label: "Customers who ordered",
      now: String(freq.activeCustomers),
      before: String(freqBefore.activeCustomers),
      lastYear: String(freqLastYear.activeCustomers),
      change: changeInCount(freq.activeCustomers, freqBefore.activeCustomers),
    },
    {
      label: "Orders per customer",
      now: freq.perActiveCustomer === null ? "—" : String(freq.perActiveCustomer),
      before:
        freqBefore.perActiveCustomer === null
          ? "—"
          : String(freqBefore.perActiveCustomer),
      lastYear:
        freqLastYear.perActiveCustomer === null
          ? "—"
          : String(freqLastYear.perActiveCustomer),
      change: changeInCount(
        freq.perActiveCustomer ?? 0,
        freqBefore.perActiveCustomer ?? 0,
      ),
    },
  ];

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-[28px] leading-[34px] font-semibold text-ink">
          Bill size &amp; frequency
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {REPORT_PERIOD_LABELS[period]} · {rangeLabel(range)}
        </p>
      </div>

      <FilterBar options={options} period={period} from={custom.from} to={custom.to} />

      {size.transactions === 0 ? (
        <EmptyState
          title="Nothing was sold in this period"
          body="A transaction here is an order accounts have accepted — the same definition the buying cycle and the targets read, so an order still waiting on approval is not counted anywhere as a sale."
        />
      ) : (
        <>
          <Section
            title="Against the period before, and against last year"
            subtitle="Seasonality in this book is real, so a month compared only against the one before it says very little. Both comparisons are the same length as the period itself — a month-to-date is never held against a whole month."
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse">
                <thead>
                  <tr>
                    <Th>Measure</Th>
                    <Th align="right">This period</Th>
                    <Th align="right">{rangeLabel(compared)}</Th>
                    <Th align="right">Change</Th>
                    <Th align="right">Same window last year</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.label}>
                      <Td>{r.label}</Td>
                      <Td align="right">
                        <span className="font-medium text-ink">{r.now}</span>
                      </Td>
                      <Td align="right">{r.before}</Td>
                      <Td align="right">
                        <ChangePill change={r.change} />
                      </Td>
                      <Td align="right">{r.lastYear}</Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {size.creditNotePaise > 0 ? (
            <Section
              title="Credit notes"
              subtitle="Netted off the sales value and never off the transaction count — a credit note is not a sale that un-happened, it is money given back on one that did. Removing the transaction would raise the average bill size every time somebody allowed a claim."
            >
              <div className="flex flex-wrap gap-x-10 gap-y-3">
                <Figure label="Billed" value={money(size.grossValuePaise)} />
                <Figure label="Credit notes issued" value={money(size.creditNotePaise)} />
                <Figure label="Net" value={money(size.netValuePaise)} />
              </div>
            </Section>
          ) : null}

          <Section
            title="How often customers buy"
            subtitle="Thresholds are configuration. The segments are counted over customers who ordered at all in this period — dividing by the whole book would make the figure fall every time somebody added a prospect."
          >
            <div className="flex flex-wrap gap-3">
              {freq.segments.map((s) => (
                <Card key={s.segment} className="min-w-[190px] flex-1 px-4 py-3">
                  <div className="text-[12px] text-muted">{s.label}</div>
                  <div className="text-[22px] leading-7 font-semibold text-ink tabular-nums">
                    {s.customers}
                  </div>
                  <div className="text-[12px] text-muted">
                    {freq.activeCustomers
                      ? `${Math.round((s.customers / freq.activeCustomers) * 100)}% of those who ordered`
                      : ""}
                  </div>
                </Card>
              ))}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </div>
      <div className="text-[22px] leading-7 font-semibold text-ink tabular-nums">
        {value}
      </div>
    </div>
  );
}
