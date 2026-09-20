import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import Link from "next/link";
import { moneyShort } from "@/lib/format";
import { REPORT_PERIOD_LABELS, type ReportPeriod } from "@/lib/business-date";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import type { Cohort, RungFunnel } from "@/lib/services/lead-funnel-service";
import type { SharedFunnel, StepLadder } from "@/lib/engines/lead-funnel-shape";
import { SharedBarFunnel } from "./shared-bar-funnel";
import { DistributorStepLadder } from "./distributor-step-ladder";
import { LeadTabs } from "../lead-tabs";
import { Banner, FilterChips, MetricRow, Pill, ScreenHeader } from "@/components/console/parts";
import { plural } from "@/components/console/words";

/* ---------------------------------------------------------------------------
 * The three ladders, drawn.
 *
 * A SERVER component with no state of its own: every control on it is a link,
 * either into the pre-filtered book or into a different window of the same
 * screen. That is not a saving, it is the rule the Sales Dashboard already
 * follows — a filtered view is the thing a manager wants to send somebody
 * ("look at sample_trial on the direct ladder"), and a view held in component
 * state is unsendable and makes the back button a lie.
 *
 * It also means nothing here reads the clock. The business date is worked out
 * once in `page.tsx` and passed down, which is what the React Compiler rules
 * ask for and what stops two bars on one screen being measured against two
 * different days.
 * ------------------------------------------------------------------------- */

/** The windows the cohort is offered over. `today` and a custom range are both
    absent deliberately: a cohort of one day has nothing to follow forward, and
    a custom range wants two date inputs, which is a form and therefore state. */
const PERIODS: ReportPeriod[] = ["month", "last-month", "quarter", "last-quarter", "ytd"];

export function FunnelScreen({
  workspace,
  funnels,
  shared,
  distributor,
  unpictured,
  cohort,
  period,
  day,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  /** Every ladder as the service counted it — read only for the four totals. */
  funnels: RungFunnel[];
  /** §8.3a — direct and third-party in one funnel, shaped by the engine. */
  shared: SharedFunnel;
  /** §8.3b — the appointment track, as steps rather than bars. */
  distributor: StepLadder;
  /** Ladders neither picture covers. The legacy six, in practice. */
  unpictured: RungFunnel[];
  cohort: Cohort;
  period: ReportPeriod;
  /** The business date every "days on this rung" figure is measured against. */
  day: string;
}) {
  const totals = funnels.reduce(
    (acc, f) => ({
      inFunnel: acc.inFunnel + f.inFunnel,
      parked: acc.parked + f.parked,
      lost: acc.lost + f.lost,
      arrived: acc.arrived + f.arrived,
    }),
    { inFunnel: 0, parked: 0, lost: 0, arrived: 0 },
  );

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />

      <ScreenHeader
        title="Funnel & conversion"
        subtitle="Every rung of every ladder, counted, with how long the typical lead has been standing on it. The bands on the Leads screen say the pipeline is healthy; these say which rung it is stuck on."
      />

      {funnels.length === 0 ? (
        <Banner
          tone="info"
          title="No lead carries a rung yet"
          body="The funnel counts leads with a lead_stage. Nothing in the book has one — which is what a book looks like before the first lead is raised, rather than an error."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "In the funnel", value: String(totals.inFunnel) },
          {
            label: "Parked",
            value: String(totals.parked),
            sub: "On hold — off every ladder",
            tone: totals.parked > 0 ? "warn" : undefined,
          },
          { label: "Arrived", value: String(totals.arrived), sub: "Won, customer, distributor" },
          { label: "Lost", value: String(totals.lost) },
        ]}
      />

      {/*
        §8.3 ASKS FOR TWO PICTURES AND THEY ARE DRAWN DIFFERENTLY, which is the
        whole of the section. The two shop tracks are one sale and are measured
        in one funnel, split by who holds the invoice; the appointment track is
        a sequence of approvals and is drawn as a ladder, because the gap
        between two approvals is a queue and a bar chart of it would read as a
        drop-off rate that does not exist.

        Side by side rather than stacked, and NOT as parallel columns of one
        table: row four would be "sample_trial" on one and "management_review"
        on the other, and a row you can read across is an invitation to treat
        them as the same distance up the same climb.
      */}
      <div className="grid gap-4 xl:grid-cols-2">
        <SharedBarFunnel workspace={workspace} funnel={shared} />
        <DistributorStepLadder workspace={workspace} ladder={distributor} />
      </div>

      {/*
        AND THE LADDERS NEITHER PICTURE COVERS, which is the legacy six.

        The specification names two visualisations and there are four
        populations: nothing backfills a sales type — guessing which of three
        ladders somebody was on is a decision dressed up as a migration — so
        every lead raised before the funnel existed is still climbing the
        original six rungs. Drawing only what §8.3 named would leave them off
        every picture on the screen, and a pipeline that omits a population is
        the same bug `bandOf` exists to prevent, arriving through the layout.
      */}
      {unpictured.length > 0 ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          {unpictured.map((f) => (
            <Ladder workspace={workspace} key={f.salesType ?? "legacy"} funnel={f} />
          ))}
        </div>
      ) : null}

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-ink">Cohort conversion</h2>
        <p className="mt-1 max-w-[760px] text-[13px] leading-[18px] text-pretty text-muted">
          Of the leads RAISED in this window, what became of them — followed forward for{" "}
          {plural(cohort.windowDays, "day")}, never divided month by month. A lead raised on the
          29th cannot be asked to have ordered by the 31st, and a conversion from March must not be
          counted into a rate labelled August.
        </p>

        <div className="mt-3">
          <FilterChips
            current={period}
            options={PERIODS.map((p) => ({
              key: p,
              label: REPORT_PERIOD_LABELS[p],
              href: leadHref(workspace, `leads/funnel?period=${p}`),
            }))}
          />
        </div>

        <CohortPanel cohort={cohort} day={day} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ a ladder */

function Ladder({
  workspace,
  funnel,
}: {
  workspace: LeadWorkspace;
  funnel: RungFunnel;
}) {
  /* Every bar is measured against the FULLEST RUNG of this ladder, not against
     the total and not against the other ladders. The question a funnel answers
     is where the book is bunching relative to itself; scaling a nine-lead
     distributor ladder against a four-hundred-lead direct one draws nine
     invisible bars and says nothing about either. */
  const widest = funnel.rungs.reduce((n, r) => Math.max(n, r.count), 0);

  return (
    <section className="rounded-[6px] border border-line bg-surface">
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h3 className="text-sm font-semibold text-ink">
            {funnel.salesType ? salesTypeLabel(funnel.salesType) : "No sales type"}
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {funnel.salesType
              ? `${plural(funnel.rungs.length, "rung")} · ${plural(funnel.inFunnel, "lead")} climbing`
              : /* The legacy ladder is not a fourth kind of sale. Nothing
                   backfills a sales type — guessing which of three ladders
                   somebody was on is a decision dressed up as a migration —
                   so these are simply the leads raised before the funnel
                   existed, still climbing the six rungs they started on. */
                `Raised before the funnel existed · ${plural(funnel.inFunnel, "lead")} climbing`}
          </p>
        </div>
        <div className="flex flex-none gap-1.5">
          {funnel.parked > 0 ? <Pill tone="warn">{funnel.parked} parked</Pill> : null}
          {funnel.arrived > 0 ? <Pill tone="success">{funnel.arrived} arrived</Pill> : null}
          {funnel.lost > 0 ? <Pill tone="neutral">{funnel.lost} lost</Pill> : null}
        </div>
      </header>

      <ol className="px-5 py-4">
        {funnel.rungs.map((rung, i) => (
          <li key={rung.stage} className="mb-2 last:mb-0">
            <Link
              href={leadHref(workspace, `leads?stage=${rung.stage}`)}
              title={`Open the ${plural(rung.count, "lead")} standing on ${stageLabel(rung.stage)}`}
              className="group block rounded-[4px] px-2 py-1.5 no-underline hover:bg-canvas hover:no-underline"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[13px] text-body">
                  <span className="mr-2 text-[11px] tabular-nums text-muted">{i + 1}</span>
                  {stageLabel(rung.stage)}
                </span>
                <span className="flex-none text-[13px] tabular-nums text-ink">
                  {rung.count}
                  {/*
                    The median is drawn only where there is one, and it carries
                    how many rows it was taken over. A median of three rows out
                    of forty is a median of three rows, and a bare "41 days"
                    beside a count of forty reads as a statement about forty
                    leads.
                  */}
                  {rung.medianDaysHere !== null ? (
                    <span
                      className="ml-2 text-xs text-muted"
                      title={`Median over the ${rung.dated} of ${rung.count} that carry a stage date`}
                    >
                      {rung.medianDaysHere}d
                      {rung.dated < rung.count ? ` (${rung.dated})` : ""}
                    </span>
                  ) : rung.count > 0 ? (
                    <span className="ml-2 text-xs text-muted" title="No lead on this rung records when it arrived">
                      no dates
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-[3px] bg-divider">
                <div
                  className="h-full rounded-[3px] bg-brand"
                  style={{ width: widest > 0 ? `${(rung.count / widest) * 100}%` : "0%" }}
                />
              </div>
              {rung.potentialPaise > 0 ? (
                <div
                  className="mt-0.5 text-[11px] text-muted"
                  title="Somebody's estimate of what these are worth. Never a derived figure, and never comparable with a real order value."
                >
                  {moneyShort(rung.potentialPaise)} estimated
                </div>
              ) : null}
            </Link>
          </li>
        ))}
      </ol>

      {funnel.offLadder.length > 0 ? (
        /*
          Rows on a stage this ladder does not have. It happens for as long as
          it takes somebody to change a lead's sales type, and it is said out
          loud rather than dropped: a funnel whose bars do not add up to its own
          total is a funnel nobody trusts twice.
        */
        <footer className="border-t border-line bg-canvas px-5 py-3 text-[13px] text-body">
          <span className="font-medium text-ink">Not on this ladder: </span>
          {funnel.offLadder.map((r, i) => (
            <span key={r.stage}>
              {i > 0 ? ", " : ""}
              <Link href={leadHref(workspace, `leads?stage=${r.stage}`)} className="text-[#5223E0]">
                {stageLabel(r.stage)} ({r.count})
              </Link>
            </span>
          ))}
          <span className="text-muted">
            {" "}
            — a rung their sales type does not carry, usually because the type was changed under
            them. Shown rather than dropped; moving them is a stage move like any other.
          </span>
        </footer>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ cohort */

function CohortPanel({ cohort, day }: { cohort: Cohort; day: string }) {
  const pct = (n: number) => (cohort.rate === null ? "—" : `${(n * 100).toFixed(1)}%`);

  return (
    <>
      <MetricRow
        metrics={[
          {
            label: "Raised",
            value: String(cohort.raised),
            sub: `${cohort.range.from} to ${cohort.range.to}`,
          },
          { label: "Converted", value: String(cohort.converted), tone: "success" },
          {
            label: "Decided against",
            value: String(cohort.closedUnconverted),
            sub: "Lost, or past its window",
          },
          {
            label: "Conversion",
            value: cohort.rate === null ? "Not yet" : pct(cohort.rate),
            sub:
              cohort.rate === null
                ? "Nothing has closed its window"
                : `${cohort.converted} of ${cohort.converted + cohort.closedUnconverted} decided`,
          },
        ]}
      />

      {/*
        A COHORT READ BEFORE ITS WINDOW CLOSES IS UNFINISHED, NOT FAILING, and
        the difference between a low rate and an incomplete one is the single
        most misread figure in this module. So the still-open count is said in
        words, above the rate rather than beneath it, and it is never folded
        into the denominator — a lead eleven days old with a ninety-day window
        has not failed to convert, it has not finished.
      */}
      {cohort.stillOpen > 0 ? (
        <Banner
          tone="warn"
          title={`${plural(cohort.stillOpen, "lead")} still inside the window — this cohort is unfinished`}
          body={`They were raised less than ${plural(cohort.windowDays, "day")} before ${day} and have neither converted nor been lost, so they are counted in "raised" and in neither half of the rate. Read the figure above as what the ${cohort.converted + cohort.closedUnconverted} decided leads did, not as what the ${cohort.raised} raised ones did.`}
        />
      ) : null}

      {/*
        The other exclusion, and it is a real one rather than a rounding.
        `customers.kind = 'lead'` predates the funnel and carries no ladder, so
        "did it convert" has no answer for those rows. Counting them into the
        denominator would make the rate fall every time somebody raises a lead
        the old way, which is a conversion figure that punishes lead generation.
      */}
      {cohort.unresolved > 0 ? (
        <Banner
          tone="info"
          title={`${plural(cohort.unresolved, "lead")} raised in this window carry no rung`}
          body="They were raised without a sales type or a stage — the CRM's own kind of lead, which has no ladder to climb. They are outside this cohort entirely rather than counted as failures, because nothing about them says whether they converted."
        />
      ) : null}
    </>
  );
}
