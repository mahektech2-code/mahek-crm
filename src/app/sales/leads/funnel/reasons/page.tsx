import { isReportPeriod, reportRange, type ReportPeriod, REPORT_PERIOD_LABELS } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import {
  labelOf,
  LOST_REASONS,
  OVERRIDE_REASONS,
  PROSPECT_REASONS,
  SAMPLE_REASONS,
  type CodedOption,
} from "@/lib/lead-labels";
import {
  reasonAnalytics,
  type ReasonBreakdown,
  type ReasonGroup,
  type ReasonGroupKind,
} from "@/lib/services/lead-funnel-service";
import { LeadTabs } from "../../lead-tabs";
import { Banner, Empty, FilterChips, MetricRow, ScreenHeader } from "../../../parts";
import { plural } from "../../../words";

export const metadata = { title: "Reason codes — Sales Dashboard — MahekOne" };

/**
 * Screen 30 — the four coded lists, counted.
 *
 * THIS IS THE PAYOFF FOR STORING CODES RATHER THAN LABELS, and it is the only
 * screen in the funnel whose whole existence is that decision. "How many did
 * we lose on credit terms this quarter" is a question somebody can ask here
 * because §26's ten answers are a code in `lead_stage_transitions.reason_code`
 * — a stored label stops resolving the day somebody rewords the list, and a
 * free text box answers the same question with "price issue" in nine spellings
 * and a grep.
 *
 * Which list a code came from is derived from the MOVE, not stored beside it:
 * §5's answers are offered on the way to Prospect, §10's on the way to a
 * trial, §26's on the way out, and the override list whenever a manager passes
 * a shut gate. A column repeating that would be a second answer to a question
 * the row already answers.
 *
 * Every screen here is a READ. Nothing on it writes, because a reason is
 * recorded at the moment somebody decides something and a correction is a
 * further transition — `lead_stage_transitions` is append-only by design.
 */

/** The windows offered. A single day has too few decisions to read anything into. */
const PERIODS: ReportPeriod[] = ["month", "last-month", "quarter", "last-quarter", "ytd"];

/**
 * Each group's list, its heading and the one sentence saying what the count
 * means. The lists come from `lead-labels.ts` and are never retyped: they are
 * configuration-backed and client-safe, and a fifth copy in a screen would be
 * the copy that stops matching when somebody adds an eleventh reason.
 */
const GROUPS: Record<
  ReasonGroupKind,
  { title: string; blurb: string; list: readonly CodedOption[] | null }
> = {
  lost: {
    title: "Why leads were lost",
    blurb:
      "§26 — every move to `lost` in the window. Nobody will look at these again, which is exactly why the reason had to be asked at the time.",
    list: LOST_REASONS,
  },
  prospect: {
    title: "Why suspects became prospects",
    blurb:
      "§5 — the answer to “why are you promoting this one?”, asked so that a shop somebody happened to walk past cannot become a prospect on nothing.",
    list: PROSPECT_REASONS,
  },
  sample: {
    title: "Why a trial was wanted",
    blurb:
      "§10 — what the customer said they wanted the sample FOR. It is what the review call is measured against weeks later.",
    list: SAMPLE_REASONS,
  },
  override: {
    title: "Why a shut gate was passed",
    blurb:
      "§28 — a manager moved a lead the gate was refusing. This is not a shaming list: it is how somebody finds out one condition is shut on everybody and is the wrong condition.",
    list: OVERRIDE_REASONS,
  },
  other: {
    title: "Reasons recorded on other moves",
    blurb:
      "Codes carried by moves that are none of the four above — a revert, a park, a jump up the ladder. There is no configured list behind them, so they are shown exactly as they are stored.",
    list: null,
  },
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: asked } = await searchParams;
  const period: ReportPeriod = isReportPeriod(asked) ? asked : "quarter";

  /* The clock is read once, in the server component, and the window derived
     from it — never read during render. */
  const day = await today();
  const range = reportRange(day, period);
  const report = await reasonAnalytics(range);

  const total = (k: ReasonGroupKind) =>
    report.groups.find((g) => g.kind === k)?.total ?? 0;

  return (
    <div className="p-6">
      <LeadTabs />

      <ScreenHeader
        title="Reason codes"
        subtitle="Every coded answer the funnel demanded, counted over a window and broken down by whose lead it was and where the shop is. This is the screen the codes were stored for."
      />

      <FilterChips
        current={period}
        options={PERIODS.map((p) => ({
          key: p,
          label: REPORT_PERIOD_LABELS[p],
          href: `/sales/leads/funnel/reasons?period=${p}`,
        }))}
      />

      <MetricRow
        metrics={[
          {
            label: "Moves recorded",
            value: String(report.transitions),
            sub: `${range.from} to ${range.to}`,
          },
          { label: "Lost", value: String(total("lost")) },
          { label: "Promoted to prospect", value: String(total("prospect")) },
          { label: "Gates overridden", value: String(total("override")), tone: total("override") > 0 ? "warn" : undefined },
        ]}
      />

      {report.groups.length === 0 ? (
        <Empty
          title="No lead moved in this window"
          body="Every figure on this screen is counted from lead_stage_transitions, which is written only when a lead changes rung. Nothing moved between these dates — which is a fact about the fortnight, not an empty report."
        />
      ) : (
        <div className="space-y-5">
          {report.groups.map((g) => (
            <GroupCard key={g.kind} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- a group */

function GroupCard({ group }: { group: ReasonGroup }) {
  const { title, blurb, list } = GROUPS[group.kind];

  /*
   * THE WHOLE LIST IS DRAWN, including the codes nobody picked.
   *
   * A reason at zero is an answer — "nobody lost anything on quality this
   * quarter" is worth reading and is invisible on a table of what happened to
   * be chosen. And any code that was RECORDED but is not in the list is
   * appended rather than dropped: a list is configuration and a reworded or
   * retired code still sits on every row written before it changed.
   * `labelOf` falls back to the raw code, so it renders as itself rather than
   * vanishing.
   */
  const known = list ? list.map((o) => o.code) : [];
  const recorded = new Map(group.byReason.map((r) => [r.code, r.count]));
  const codes = [
    ...known.map((code) => ({ code, count: recorded.get(code) ?? 0, known: true })),
    ...group.byReason
      .filter((r) => !known.includes(r.code))
      .map((r) => ({ code: r.code, count: r.count, known: false })),
  ].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const widest = codes.reduce((n, c) => Math.max(n, c.count), 0);
  const nameOf = (code: string) => (list ? labelOf(list, code) : code);

  return (
    <section className="rounded-[6px] border border-line bg-surface">
      <header className="border-b border-line px-5 py-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <span className="flex-none text-[13px] tabular-nums text-muted">
            {plural(group.total, "move")}
          </span>
        </div>
        <p className="mt-1 max-w-[760px] text-[13px] leading-[18px] text-pretty text-muted">
          {blurb}
        </p>
      </header>

      {/*
        An uncoded move is a question somebody can no longer ask, and it is
        counted rather than dropped: a reason table totalling less than the
        number of losses above it reads as a broken query, when the true answer
        is that these were recorded before the code was demanded or through a
        path that does not demand one.
      */}
      {group.uncoded > 0 ? (
        <div className="px-5 pt-4">
          <Banner
            tone="warn"
            title={`${plural(group.uncoded, "move")} carry no reason code`}
            body="They are counted in the total above and appear in no row below. Nothing can reconstruct what somebody had in mind at the time, so this number only ever goes down for moves made from here on."
          />
        </div>
      ) : null}

      <div className="grid gap-x-8 gap-y-5 px-5 py-4 lg:grid-cols-3">
        <div>
          <h3 className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            By reason
          </h3>
          {codes.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing coded in this window.</p>
          ) : (
            <ul>
              {codes.map((c) => (
                <li key={c.code} className="mb-1.5 last:mb-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={
                        c.count === 0
                          ? "truncate text-[13px] text-muted"
                          : "truncate text-[13px] text-body"
                      }
                      title={c.known ? undefined : `Stored code — not in the current list`}
                    >
                      {nameOf(c.code)}
                    </span>
                    <span className="flex-none text-[13px] tabular-nums text-ink">{c.count}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-[3px] bg-divider">
                    <div
                      className="h-full rounded-[3px] bg-brand"
                      style={{ width: widest > 0 ? `${(c.count / widest) * 100}%` : "0%" }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/*
          Whose lead it was — `customers.owner_id`, which is what
          `ASSIGNED_TO_SQL` reads for a lead, and deliberately NOT the
          transition's own actor. On an overridden move that actor is the
          manager who passed the gate, and grouping by it would file every
          override against the same three names and answer a question nobody
          asked.
        */}
        <Breakdown
          heading="By salesman"
          rows={group.bySalesman}
          nameOf={nameOf}
          none="Nobody assigned"
        />
        <Breakdown heading="By city" rows={group.byCity} nameOf={nameOf} none="No city recorded" />
      </div>
    </section>
  );
}

/** How many rows of a breakdown are drawn before the tail is said in words. */
const BREAKDOWN_ROWS = 10;

function Breakdown({
  heading,
  rows,
  nameOf,
  none,
}: {
  heading: string;
  rows: ReasonBreakdown[];
  nameOf: (code: string) => string;
  /** What a null id is CALLED. Blank is not an answer on a list somebody acts on. */
  none: string;
}) {
  const shown = rows.slice(0, BREAKDOWN_ROWS);
  const rest = rows.slice(BREAKDOWN_ROWS);
  const restCount = rest.reduce((n, r) => n + r.count, 0);

  return (
    <div>
      <h3 className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {heading}
      </h3>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing in this window.</p>
      ) : (
        <ul>
          {shown.map((r) => (
            <li key={r.id ?? "__none__"} className="mb-1.5 flex items-baseline gap-2 last:mb-0">
              <span className="min-w-0 flex-1 truncate text-[13px] text-body">
                {r.label ?? none}
              </span>
              {/* The commonest code beside the count, because "Rakesh: 14" is a
                  number and "Rakesh: 14, mostly credit terms" is something to
                  do something about. */}
              {r.topCode ? (
                <span className="flex-none truncate text-xs text-muted" title={nameOf(r.topCode)}>
                  {nameOf(r.topCode)}
                </span>
              ) : null}
              <span className="flex-none text-[13px] tabular-nums text-ink">{r.count}</span>
            </li>
          ))}
          {rest.length > 0 ? (
            /* A capped list says what it is a slice of. The tail is counted
               rather than silently cut, so the column still adds up to the
               group's own total. */
            <li className="mt-1.5 text-xs text-muted">
              and {rest.length} more, {restCount} between them
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
