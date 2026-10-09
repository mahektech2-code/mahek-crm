import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { longDate } from "@/lib/format";
import {
  activityHistory,
  activityHistoryCounts,
  activityHistorySalesmen,
  type ActivityMatch,
  type ActivitySource,
} from "@/lib/services/sales-service";
import { Empty, FilterChips, ScreenHeader } from "@/components/console/parts";
import { ActivityTable } from "./activity-table";
import { ReparseButton } from "./reparse-button";
import { getCurrentUser } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/access-control";
import { canOpenModule } from "@/lib/access";

export const metadata = {
  title: "Activity history — Sales Dashboard — MahekOne",
};

/**
 * Every visit the field team made: MBOS visits, which are the record, and —
 * for the days before `fieldActivity.cutoverDate` only — the old field app's
 * (EMP 2.0) sheet, marked as such. `activityHistory` in the sales service
 * carries the reasoning.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    salesman?: string;
    source?: string;
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
    : addDays(now, -30);
  const salesman = /^[un]:.+/.test(params.salesman ?? "")
    ? params.salesman
    : undefined;
  const match = (["matched", "ambiguous", "unmatched"] as const).includes(
    params.match as never,
  )
    ? (params.match as ActivityMatch)
    : undefined;
  // A match is a question about the old app's rows, so it implies them.
  const source: ActivitySource | undefined = match
    ? "sheet"
    : params.source === "mbos" || params.source === "sheet"
      ? params.source
      : undefined;
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = [25, 50, 100].includes(Number(params.per))
    ? Number(params.per)
    : 50;

  const me = await getCurrentUser();
  const canReparse = !!me && (await isPlatformAdmin(me));
  // Standing behind or asking about a visit are Journeys & visits' actions.
  const canActOnVisits = !!me && (await canOpenModule(me.id, "sales.journeys"));

  const [people, counts, result] = await Promise.all([
    activityHistorySalesmen(),
    activityHistoryCounts({ from, to, salesman }),
    activityHistory({ from, to, salesman, source, match, page, perPage }),
  ]);
  const cutover = result.cutover;
  const rangeTouchesOldApp = from < cutover;

  const query = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams({ from, to });
    if (salesman) q.set("salesman", salesman);
    if (source) q.set("source", source);
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
        subtitle={`Every visit the field team logged. MBOS is the record; before ${longDate(cutover)} the old field app (EMP 2.0) is shown beside it, marked "Old app".`}
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
              defaultValue={salesman ?? ""}
              className={`${input} max-w-[260px]`}
            >
              <option value="">Everybody</option>
              {people.accounts.length ? (
                <optgroup label="On MahekOne">
                  {people.accounts.map((p) => (
                    <option key={p.id} value={`u:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {people.sheetNames.length ? (
                <optgroup label="Old app only (no account)">
                  {people.sheetNames.map((p) => (
                    <option key={p.name} value={`n:${p.name}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </Field>
          {source ? <input type="hidden" name="source" value={source} /> : null}
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
            current={source ?? "all"}
            options={[
              {
                key: "all",
                href: qs({ source: undefined, match: undefined }),
                label: "All",
                count: counts.all,
              },
              {
                key: "mbos",
                href: qs({ source: "mbos", match: undefined }),
                label: "MBOS",
                count: counts.mbos,
              },
              ...(rangeTouchesOldApp || counts.sheet
                ? [
                    {
                      key: "sheet",
                      href: qs({ source: "sheet", match: undefined }),
                      label: "Old app",
                      count: counts.sheet,
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </div>

      {source === "sheet" ? (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className="text-[12px] text-muted">
            Old app rows, by whether the shop was found on MahekOne:
          </span>
          <div className="[&>div]:mb-0">
            <FilterChips
              current={match ?? "all"}
              options={[
                {
                  key: "all",
                  href: qs({ match: undefined }),
                  label: "Any",
                  count: counts.sheet,
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
      ) : null}

      {to >= cutover && rangeTouchesOldApp ? (
        <p className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2 text-[13px] text-body">
          From <span className="font-medium">{longDate(cutover)}</span>{" "}
          only MBOS visits are shown. The old app&rsquo;s sheet is kept as it was for
          the days before.
        </p>
      ) : null}

      {result.rows.length === 0 ? (
        <Empty
          title={
            result.everAnything
              ? "Nothing in this range"
              : "No visits have been logged yet"
          }
          body={
            result.everAnything
              ? "Widen the dates, clear the salesman or pick All."
              : "Visits appear here as salesmen check in and out of shops on MBOS."
          }
        />
      ) : (
        <ActivityTable
          rows={result.rows}
          total={result.total}
          page={result.page}
          perPage={result.perPage}
          baseQuery={query({})}
          canActOnVisits={canActOnVisits}
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
