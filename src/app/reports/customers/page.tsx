import Link from "next/link";
import { money } from "@/lib/format";
import { today } from "@/lib/recompute";
import { addMonths, monthKey } from "@/lib/business-date";
import {
  HEALTH_BANDS,
  HEALTH_BAND_LABELS,
  type HealthBand,
} from "@/lib/engines/inactivity";
import { retention } from "@/lib/engines/owner-kpis";
import {
  bandedCustomers,
  filterOptions,
  movementSince,
} from "@/lib/services/owner-dashboard-service";
import { Callout, EmptyState, Td, Th, Tr } from "@/components/ui/primitives";
import { FilterBar } from "../filters";
import { BAND_TONE, Section, readParams, withParams, type ReportQuery } from "../parts";
import { ExportButton } from "../export-button";

export const metadata = { title: "Customer health - Reports - MahekOne" };

/**
 * Who is still buying, and who moved.
 *
 * The list is the point. A band count tells the owner there are 145 customers
 * at risk; this tells them WHICH, whose book each is in, when they were last
 * spoken to and what they owe — which is everything needed to hand the list to
 * somebody and have them work it.
 *
 * The period filter above deliberately does NOT narrow this. A band is a
 * statement about where a customer stands TODAY, measured against their own
 * cycle — it is not a thing that happened inside a date range, and filtering
 * it by one would produce a number nobody could explain. The date filters
 * still apply to the movement section, which genuinely is about two moments.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<ReportQuery & { band?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const { period, filters, custom } = readParams(params, now);

  const selected = HEALTH_BANDS.includes(params.band as HealthBand)
    ? (params.band as HealthBand)
    : null;

  const [health, options, moved] = await Promise.all([
    bandedCustomers(now, filters),
    filterOptions(),
    movementSince(addMonths(monthKey(now), -1), now, filters),
  ]);

  const counts = retention(health.banded.map((b) => b.band));
  const rows = selected
    ? health.banded.filter((c) => c.band === selected)
    : health.banded;

  // Worst first within the list: the account furthest past its own rhythm is
  // the one somebody should ring first, and it is not the one that owes most.
  const listed = [...rows].sort((a, b) => b.cyclesElapsed - a.cyclesElapsed);

  const csv = [
    [
      "Customer",
      "Band",
      "Salesperson",
      "Last order",
      "Cycle (days)",
      "Expected",
      "Days overdue",
      "Last call",
      "Last outcome",
      "Next call",
      "Outstanding",
    ],
    ...listed.map((c) => [
      c.name,
      HEALTH_BAND_LABELS[c.band],
      c.ownerName ?? "",
      c.lastOrderDate ?? "",
      c.cycleDays,
      c.expectedOn ?? "",
      c.daysOverdue,
      c.lastCallOn ?? "",
      c.lastCallOutcome ?? "",
      c.nextCallOn ?? "",
      (c.outstandingPaise / 100).toFixed(2),
    ]),
  ];

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-[28px] leading-[34px] font-semibold text-ink">
          Customer health
        </h1>
        <p className="mt-1 max-w-[820px] text-[13px] text-pretty text-muted">
          Measured against each customer&rsquo;s own buying cycle rather than a flat
          30/60/90 — a fortnightly buyer and a twice-a-year buyer are both a quarter
          late at 1.25 of their own rhythm. Dormant is the same threshold that marks a
          customer inactive in the CRM, so the two screens cannot disagree about one
          account.
        </p>
      </div>

      <FilterBar options={options} period={period} from={custom.from} to={custom.to} />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link
          href={withParams("/reports/customers", { ...params, band: undefined })}
          className={
            selected === null
              ? "rounded-[4px] border border-brand bg-brand-soft px-3 py-1.5 text-[13px] font-medium text-[#5223E0] no-underline hover:no-underline"
              : "rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          }
        >
          Everybody ({counts.total})
        </Link>
        {HEALTH_BANDS.map((band) => (
          <Link
            key={band}
            href={withParams("/reports/customers", params, { band })}
            className={
              selected === band
                ? "rounded-[4px] border border-brand bg-brand-soft px-3 py-1.5 text-[13px] font-medium text-[#5223E0] no-underline hover:no-underline"
                : "rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
            }
          >
            {HEALTH_BAND_LABELS[band]} ({counts.counts[band]})
          </Link>
        ))}
      </div>

      {/* ---------------------------------------------------- movement, §22 */}
      <Section
        title="Who moved"
        subtitle="The figure that says whether anybody is being got back. A book with 145 at risk in both months looks stable and may be 145 different customers, half recovered and half newly slipping — the counts cannot tell those apart."
      >
        {moved === null ? (
          <p className="text-[13px] text-muted">
            There is no earlier reading to compare against yet. A band is a statement
            about a day and cannot be reconstructed after the fact, so this fills in
            once a month of nightly snapshots has been taken.
          </p>
        ) : moved.movements.filter((m) => m.direction !== "held").length === 0 ? (
          <p className="text-[13px] text-muted">
            Nobody changed band since {moved.comparedWith}.
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {moved.movements
              .filter((m) => m.direction !== "held")
              .slice(0, 12)
              .map((m) => (
                <div
                  key={`${m.from}-${m.to}`}
                  className="min-w-[190px] rounded-[6px] border border-line bg-canvas px-4 py-3"
                >
                  <div className="text-[13px] text-body">
                    {HEALTH_BAND_LABELS[m.from]} → {HEALTH_BAND_LABELS[m.to]}
                  </div>
                  <div
                    className={
                      m.direction === "recovered"
                        ? "text-[22px] leading-7 font-semibold text-success tabular-nums"
                        : "text-[22px] leading-7 font-semibold text-danger tabular-nums"
                    }
                  >
                    {m.customers}
                  </div>
                  <div className="text-[12px] text-muted">
                    {m.direction === "recovered" ? "came back" : "slipped"}
                  </div>
                </div>
              ))}
          </div>
        )}
      </Section>

      {health.neverOrdered > 0 || health.defaultCycle > 0 ? (
        <Callout tone="brand">
          {health.neverOrdered > 0 ? (
            <>
              <strong className="font-medium">
                {health.neverOrdered} customer
                {health.neverOrdered === 1 ? " has" : "s have"} never ordered
              </strong>{" "}
              and are in no band at all. They have not stopped buying, they have not
              started — counting them as Active is how a retention figure flatters
              itself, and counting them as Lost would be worse.{" "}
            </>
          ) : null}
          {health.defaultCycle > 0 ? (
            <>
              {health.defaultCycle} of the banded have no measured buying cycle yet and
              are judged against the configured default, so their band is as good as
              that guess.
            </>
          ) : null}
        </Callout>
      ) : null}

      <Section
        title={selected ? `${HEALTH_BAND_LABELS[selected]} customers` : "Every banded customer"}
        subtitle="Furthest past their own cycle first — that is who to ring, and it is not the same as who owes the most."
        actions={
          <ExportButton
            name={`customer-health-${selected ?? "all"}-${now}`}
            rows={csv}
          />
        }
      >
        {listed.length === 0 ? (
          <EmptyState
            title="Nobody in this band"
            body="Either the filters have narrowed everything out, or there is genuinely nobody here."
          />
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <table className="w-full min-w-[1100px] border-collapse">
              <thead>
                <tr>
                  <Th>Customer</Th>
                  <Th>Band</Th>
                  <Th>Salesperson</Th>
                  <Th align="right">Last order</Th>
                  <Th align="right">Cycle</Th>
                  <Th align="right">Expected</Th>
                  <Th align="right">Overdue</Th>
                  <Th align="right">Last call</Th>
                  <Th>Outcome</Th>
                  <Th align="right">Next call</Th>
                  <Th align="right">Outstanding</Th>
                </tr>
              </thead>
              <tbody>
                {listed.slice(0, 500).map((c) => (
                  <Tr key={c.customerId}>
                    <Td>
                      <Link
                        href={`/crm/customers/${c.customerId}`}
                        className="font-medium text-ink no-underline hover:underline"
                      >
                        {c.name}
                      </Link>
                    </Td>
                    <Td>
                      <span
                        className={`inline-flex rounded-[9px] px-2 py-[3px] text-[11px] font-medium tracking-[0.03em] uppercase ${BAND_TONE[c.band]}`}
                      >
                        {HEALTH_BAND_LABELS[c.band]}
                      </span>
                    </Td>
                    <Td>{c.ownerName ?? <span className="text-muted">nobody</span>}</Td>
                    <Td align="right">{c.lastOrderDate ?? "—"}</Td>
                    <Td align="right">
                      {c.cycleDays}d
                      {!c.cycleIsMeasured ? (
                        <span
                          className="ml-1 text-muted"
                          title="No measured cycle yet — this is the configured default, so the band is as good as that guess."
                        >
                          *
                        </span>
                      ) : null}
                    </Td>
                    <Td align="right">{c.expectedOn ?? "—"}</Td>
                    <Td align="right">
                      {c.daysOverdue ? `${c.daysOverdue}d` : <span className="text-muted">—</span>}
                    </Td>
                    <Td align="right">
                      {c.lastCallOn ?? <span className="text-muted">never</span>}
                    </Td>
                    <Td>
                      {c.lastCallOutcome ?? <span className="text-muted">—</span>}
                    </Td>
                    <Td align="right">
                      {c.nextCallOn ?? <span className="text-muted">—</span>}
                    </Td>
                    <Td align="right">
                      {c.outstandingPaise ? (
                        money(c.outstandingPaise)
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </table>
            {listed.length > 500 ? (
              <p className="mt-2 text-[12px] text-muted">
                Showing the 500 furthest past their cycle of {listed.length}. The export
                carries all of them.
              </p>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
