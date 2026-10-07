import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import {
  fieldActivityHistory,
  fieldActivityMatchCounts,
  fieldActivitySalesmen,
} from "@/lib/services/sales-service";
import { Empty, FilterChips, ScreenHeader } from "@/components/console/parts";
import { ActivityTable } from "./activity-table";
import { ReparseButton } from "./reparse-button";
import { getCurrentUser } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/access-control";

export const metadata = {
  title: "Activity history — Sales Dashboard — MahekOne",
};

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
  searchParams: Promise<{
    from?: string;
    to?: string;
    salesman?: string;
    match?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const params = await searchParams;
  const now = await today();

  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? "") ? params.to! : now;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? "")
    ? params.from!
    : addDays(now, -90);
  const salesmanName = params.salesman || undefined;
  const match = (["matched", "ambiguous", "unmatched"] as const).includes(
    params.match as never,
  )
    ? (params.match as "matched" | "ambiguous" | "unmatched")
    : undefined;
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = [25, 50, 100].includes(Number(params.per))
    ? Number(params.per)
    : 50;

  const me = await getCurrentUser();
  const canReparse = !!me && (await isPlatformAdmin(me));

  const [salesmen, counts, result] = await Promise.all([
    fieldActivitySalesmen(),
    fieldActivityMatchCounts({ from, to, salesmanName }),
    fieldActivityHistory({
      from,
      to,
      salesmanName,
      matchStatus: match,
      page,
      perPage,
    }),
  ]);

  const query = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams({ from, to });
    if (salesmanName) q.set("salesman", salesmanName);
    if (match) q.set("match", match);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) q.delete(k);
      else q.set(k, v);
    }
    return q.toString();
  };
  const qs = (patch: Record<string, string | undefined>) =>
    `/sales/activity-history?${query(patch)}`;
  const input =
    "h-8 rounded-[4px] border border-line bg-canvas px-2 text-[13px]";

  return (
    <div className="p-6">
      <ScreenHeader
        title="Activity history"
        subtitle="Visits and calls from the old field app (EMP 2.0)."
        actions={canReparse ? <ReparseButton /> : undefined}
      />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <input
              type="date"
              name="from"
              defaultValue={from}
              className={input}
            />
          </Field>
          <Field label="To">
            <input type="date" name="to" defaultValue={to} className={input} />
          </Field>
          <Field label="Salesman">
            <select
              name="salesman"
              defaultValue={salesmanName ?? ""}
              className={input}
            >
              <option value="">Everybody</option>
              {salesmen.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          {match ? <input type="hidden" name="match" value={match} /> : null}
          <button
            type="submit"
            className="h-8 cursor-pointer rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-body hover:bg-divider"
          >
            Apply
          </button>
        </form>

        <div className="[&>div]:mb-0">
          <FilterChips
            current={match ?? "all"}
            options={[
              {
                key: "all",
                href: qs({ match: undefined }),
                label: "All",
                count: counts.all,
              },
              {
                key: "matched",
                href: qs({ match: "matched" }),
                label: "Matched",
                count: counts.matched,
              },
              {
                key: "ambiguous",
                href: qs({ match: "ambiguous" }),
                label: "Needs review",
                count: counts.ambiguous,
              },
              {
                key: "unmatched",
                href: qs({ match: "unmatched" }),
                label: "No match",
                count: counts.unmatched,
              },
            ]}
          />
        </div>
      </div>

      {result.rows.length === 0 ? (
        /* THREE REASONS TO BE EMPTY, and they need three different things
           doing about them — see `fieldActivityHistory`'s `everInTable`. */
        <Empty
          title={
            result.everInTable === 0
              ? "Nothing has been imported yet"
              : "Nothing in this range"
          }
          body={
            result.everInTable === 0
              ? "Run the field-activity sync from the Admin Console, then come back."
              : `Widen the dates or clear the salesman. ${result.everInTable.toLocaleString("en-IN")} rows are stored in total.`
          }
        />
      ) : (
        <ActivityTable
          rows={result.rows}
          total={result.total}
          page={result.page}
          perPage={result.perPage}
          baseQuery={query({})}
        />
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}
