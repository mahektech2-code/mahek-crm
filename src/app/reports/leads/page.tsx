import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { REPORT_PERIOD_LABELS } from "@/lib/business-date";
import { conversionFor } from "@/lib/engines/owner-kpis";
import {
  breakdownBy,
  filterOptions,
  leadsCreatedIn,
} from "@/lib/services/owner-dashboard-service";
import { Callout, EmptyState, Td, Th, Tr } from "@/components/ui/primitives";
import { FilterBar } from "../filters";
import { Section, rangeLabel, readParams, type ReportQuery } from "../parts";
import { ExportButton } from "../export-button";

export const metadata = { title: "Leads & conversion - Reports - MahekOne" };

const DIMENSIONS = [
  { key: "owner", label: "By salesperson" },
  { key: "source", label: "By source" },
  { key: "origin", label: "By where it was captured" },
  { key: "state", label: "By region" },
  { key: "city", label: "By city" },
  { key: "customerType", label: "By customer type" },
] as const;

/**
 * Where new business came from, and what became of it.
 *
 * §6 and §11 ask for the same table under two headings — leads by salesman,
 * conversion by salesman — so it is ONE table with both columns rather than
 * two lists somebody has to hold side by side. The owner's actual question is
 * never "who generated leads", it is "who generated leads that turned into
 * anything", and those are only comparable in the same row.
 *
 * Every cut is computed over the cohort the page already loaded rather than
 * re-queried per dimension: six queries of the same cohort is six chances for
 * a breakdown to disagree with the total above it.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<ReportQuery & { by?: string }>;
}) {
  const params = await searchParams;
  const now = await today();
  const config = await getConfig();
  const { period, range, filters, custom } = readParams(params, now);

  const [cohort, options] = await Promise.all([
    leadsCreatedIn(range, filters),
    filterOptions(),
  ]);

  const conversion = conversionFor(cohort, now, config);
  const dimension =
    (DIMENSIONS.find((d) => d.key === params.by)?.key ?? "owner") as
      (typeof DIMENSIONS)[number]["key"];
  const rows = breakdownBy(cohort, dimension, now, config);

  const csv = [
    ["Lead", "Where", "Source", "Salesperson", "Region", "City", "Created", "Stage", "First order"],
    ...cohort.map((l) => [
      l.leadId,
      l.origin === "field" ? "Field" : "CRM",
      l.source ?? "",
      l.ownerName ?? "",
      l.state ?? "",
      l.city ?? "",
      l.createdOn,
      l.stage ?? "",
      l.firstOrderOn ?? "",
    ]),
  ];

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-[28px] leading-[34px] font-semibold text-ink">
          Leads &amp; conversion
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {REPORT_PERIOD_LABELS[period]} · {rangeLabel(range)} · the cohort created in
          this window, followed forward {conversion.windowDays} days
        </p>
      </div>

      <FilterBar options={options} period={period} from={custom.from} to={custom.to} />

      {!conversion.windowClosed && conversion.leads > 0 ? (
        <Callout tone="brand">
          <strong className="font-medium">This cohort has not finished.</strong>{" "}
          {conversion.stillOpen} of {conversion.leads} leads are still inside their{" "}
          {conversion.windowDays}-day window. The rate below can only rise.
        </Callout>
      ) : null}

      {cohort.length === 0 ? (
        <EmptyState
          title="No leads were created in this period"
          body="A lead is counted from the day it was created, in either place this product keeps one — a party the telecalling team added, or somebody a salesman met and recorded on the handset."
        />
      ) : (
        <>
          <Section
            title="The cohort"
            subtitle="Qualification exists only on field leads — a CRM lead is a party the book knows has not ordered, and has no ladder at all. That is why the headline rate is measured over ALL leads and the qualified rate sits beside it rather than replacing it: a denominator that silently dropped every lead incapable of being qualified would report a flattering number."
          >
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <Figure label="Leads created" value={String(conversion.leads)} />
              <Figure
                label="Placed a first order"
                value={String(conversion.converted)}
              />
              <Figure
                label="Conversion"
                value={
                  conversion.ratePercent === null ? "—" : `${conversion.ratePercent}%`
                }
                sub="of every lead in the cohort"
              />
              <Figure
                label="Of the qualified"
                value={
                  conversion.qualifiedRatePercent === null
                    ? "—"
                    : `${conversion.qualifiedRatePercent}%`
                }
                sub={
                  conversion.qualified
                    ? `${conversion.qualifiedConverted} of ${conversion.qualified} field leads`
                    : "no field leads reached qualification"
                }
              />
            </div>
          </Section>

          <Section
            title="Break it down"
            subtitle="Overall conversion tells the owner there is a problem. This is the table that says where."
            actions={
              <div className="flex items-center gap-2">
                <ExportButton
                  name={`leads-${range.from}-to-${range.to}`}
                  rows={csv}
                />
              </div>
            }
          >
            <div className="mb-3 flex flex-wrap gap-1">
              {DIMENSIONS.map((d) => (
                <a
                  key={d.key}
                  href={`?${new URLSearchParams({ ...cleanParams(params), by: d.key }).toString()}`}
                  className={
                    d.key === dimension
                      ? "rounded-[4px] border border-brand bg-brand-soft px-2.5 py-1 text-[12px] font-medium text-[#5223E0] no-underline hover:no-underline"
                      : "rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] text-body no-underline hover:bg-canvas hover:no-underline"
                  }
                >
                  {d.label}
                </a>
              ))}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse">
                <thead>
                  <tr>
                    <Th>{DIMENSIONS.find((d) => d.key === dimension)?.label.slice(3)}</Th>
                    <Th align="right">Leads</Th>
                    <Th align="right">Qualified</Th>
                    <Th align="right">First orders</Th>
                    <Th align="right">Conversion</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.key}>
                      <Td>{r.label}</Td>
                      <Td align="right">{r.leads}</Td>
                      <Td align="right">
                        {r.qualified || <span className="text-muted">—</span>}
                      </Td>
                      <Td align="right">{r.converted}</Td>
                      <Td align="right">
                        {r.ratePercent === null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span
                            className={
                              r.ratePercent >= (conversion.ratePercent ?? 0)
                                ? "text-success"
                                : "text-body"
                            }
                          >
                            {r.ratePercent}%
                          </span>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function cleanParams(params: ReportQuery & { by?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v) out[k] = String(v);
  return out;
}

function Figure({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="max-w-[240px]">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </div>
      <div className="text-[22px] leading-7 font-semibold text-ink tabular-nums">
        {value}
      </div>
      {sub ? <div className="text-[12px] text-pretty text-muted">{sub}</div> : null}
    </div>
  );
}
