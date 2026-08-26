import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import {
  fieldActivityHistory,
  fieldActivityMatchCounts,
  fieldActivitySalesmen,
} from "@/lib/services/sales-service";
import {
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";

export const metadata = { title: "Activity history — Sales Dashboard — MahekOne" };

const MATCH_TONE = { matched: "success", ambiguous: "warn", unmatched: "neutral" } as const;
const MATCH_LABEL = { matched: "Matched", ambiguous: "Needs review", unmatched: "No match", pending: "Pending" } as const;

/**
 * A manager's read of the "Mahek EMP 2.0" field activity backfill — the
 * WHOLE imported record, including rows that never resolved to a real
 * customer, unlike the MBOS device's own `timeline` pull channel, which only
 * ever receives the matched subset. See `sheet_field_activity_rows`'s own
 * doc comment in schema.ts for why this is a separate table from `mbos_visits`
 * rather than a filter on the Visits screen.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; salesman?: string; match?: string }>;
}) {
  const params = await searchParams;
  const now = await today();

  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? "") ? params.to! : now;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? "") ? params.from! : addDays(now, -90);
  const salesmanId = params.salesman || undefined;
  const match = (["matched", "ambiguous", "unmatched"] as const).includes(params.match as never)
    ? (params.match as "matched" | "ambiguous" | "unmatched")
    : undefined;

  const [salesmen, counts, result] = await Promise.all([
    fieldActivitySalesmen(),
    fieldActivityMatchCounts({ from, to, salesmanId }),
    fieldActivityHistory({ from, to, salesmanId, matchStatus: match }),
  ]);

  const qs = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams({ from, to });
    if (salesmanId) params.set("salesman", salesmanId);
    if (match) params.set("match", match);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) params.delete(k);
      else params.set(k, v);
    }
    return `/sales/activity-history?${params.toString()}`;
  };

  return (
    <div className="p-6">
      <ScreenHeader
        title="Activity history"
        subtitle="Field salesman visits and calls logged in a prior system, before this app existed. Rows that resolve to a real customer also reach that customer's shared timeline and the salesman's phone; rows that don't are shown here so they can be reviewed."
      />

      <MetricRow
        metrics={[
          { label: "In range", value: String(counts.all) },
          { label: "Matched", value: String(counts.matched), tone: counts.matched ? "success" : undefined },
          {
            label: "Needs review",
            value: String(counts.ambiguous),
            sub: counts.ambiguous ? "more than one candidate customer" : undefined,
            tone: counts.ambiguous ? "warn" : undefined,
          },
          {
            label: "No match",
            value: String(counts.unmatched),
            sub: counts.unmatched ? "no candidate close enough" : undefined,
          },
        ]}
      />

      <form
        method="get"
        className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-[6px] border border-line bg-surface px-5 py-3.5"
      >
        <Field label="From">
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="rounded-[4px] border border-line bg-canvas px-2 py-1 text-[13px]"
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="rounded-[4px] border border-line bg-canvas px-2 py-1 text-[13px]"
          />
        </Field>
        <Field label="Salesman">
          <select
            name="salesman"
            defaultValue={salesmanId ?? ""}
            className="rounded-[4px] border border-line bg-canvas px-2 py-1 text-[13px]"
          >
            <option value="">Everybody</option>
            {salesmen.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {match ? <input type="hidden" name="match" value={match} /> : null}
        <button
          type="submit"
          className="h-8 rounded-[4px] border border-line bg-canvas px-3 text-[13px] font-medium text-body hover:bg-divider"
        >
          Apply
        </button>
      </form>

      <FilterChips
        current={match ?? "all"}
        options={[
          { key: "all", href: qs({ match: undefined }), label: "Every row", count: counts.all },
          { key: "matched", href: qs({ match: "matched" }), label: "Matched", count: counts.matched },
          { key: "ambiguous", href: qs({ match: "ambiguous" }), label: "Needs review", count: counts.ambiguous },
          { key: "unmatched", href: qs({ match: "unmatched" }), label: "No match", count: counts.unmatched },
        ]}
      />

      {result.rows.length === 0 ? (
        <Empty
          title="Nothing in this range"
          body="Widen the date range or clear the salesman filter — this backfill spans 2022 to 2026, so a narrow default window can easily miss a quiet period."
        />
      ) : (
        <>
          {result.capped ? (
            <p className="mb-2 text-[13px] text-muted">
              Showing the newest {result.rows.length} of {result.total} — narrow the filters to see the rest.
            </p>
          ) : null}
          <Table
            minWidth={1280}
            head={
              <>
                <HeadCell width={100}>Date</HeadCell>
                <HeadCell width={170}>Salesman</HeadCell>
                <HeadCell width={220}>Customer</HeadCell>
                <HeadCell width={130}>Type / purpose</HeadCell>
                <HeadCell width={90}>Duration</HeadCell>
                <HeadCell>Note</HeadCell>
                <HeadCell width={130}>Match</HeadCell>
              </>
            }
          >
            {result.rows.map((r, i) => (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell>{r.visitDate ?? <span className="text-muted">—</span>}</Cell>
                <Cell truncate={170} title={r.employeeNameRaw ?? undefined}>
                  {r.salesmanId ? (
                    <Link href={`/sales/people/${r.salesmanId}`} className="no-underline hover:underline">
                      {r.salesmanName}
                    </Link>
                  ) : (
                    <span className="text-muted">{r.employeeNameRaw ?? "—"}</span>
                  )}
                </Cell>
                <Cell truncate={220} title={r.customerNameRaw ?? undefined}>
                  {r.customerId ? (
                    <Link href={`/crm/customers/${r.customerId}`} className="no-underline hover:underline">
                      {r.customerName}
                    </Link>
                  ) : (
                    r.customerNameRaw
                  )}
                </Cell>
                <Cell truncate={130}>
                  {[r.meetingType, r.meetingPurpose].filter(Boolean).join(" · ") || (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell>
                  {r.durationMinutes != null ? `${r.durationMinutes}m` : <span className="text-muted">—</span>}
                </Cell>
                <Cell truncate={420} title={[r.meetingNote, r.issueNote].filter(Boolean).join(" — ")}>
                  {[r.meetingNote, r.issueNote].filter(Boolean).join(" — ") || (
                    <span className="text-muted">—</span>
                  )}
                </Cell>
                <Cell truncate={130} title={r.matchNote ?? undefined}>
                  <Pill tone={MATCH_TONE[r.customerMatchStatus as keyof typeof MATCH_TONE] ?? "neutral"}>
                    {MATCH_LABEL[r.customerMatchStatus]}
                  </Pill>
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
      {children}
    </label>
  );
}
