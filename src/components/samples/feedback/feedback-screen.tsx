import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import Link from "next/link";
import { shortDate } from "@/lib/format";
import {
  FEEDBACK_FIELDS,
  SAMPLE_CANCEL_PROBLEM_LABELS,
  labelOf,
  sampleCancelProblemOf,
  sampleStateLabel,
  type SampleCancelProblem,
  type SampleState,
} from "@/lib/lead-labels";
import type {
  TrialCancellations,
  TrialFeedbackFacets,
  TrialFeedbackRow,
  TrialVerdicts,
} from "@/lib/services/sample-trials-service";
import { LeadTabs } from "../../leads/lead-tabs";
import {
  Banner,
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "@/components/console/parts";
import { plural } from "@/components/console/words";

type Selected = {
  product: string | null;
  competitor: string | null;
  outcome: string | null;
};

/**
 * The trial feedback library.
 *
 * A SERVER COMPONENT, deliberately. It writes nothing, it holds no state, and
 * every filter is a URL — so there is nothing here that needs a browser, and
 * shipping the whole library to one to draw a table would be paying for
 * interactivity this screen does not have.
 *
 * **Every row is seven answers, and the blanks are named.** A field nobody
 * answered is drawn as a field nobody answered rather than left out of the
 * grid, because "they had nothing to say about drying" and "nobody asked about
 * drying" are different facts about a trial and an absent row renders them
 * identically. That distinction is the entire reason §16 is seven columns
 * rather than one box.
 *
 * **The verdict is shown as three answers, never two and a shrug.**
 * `more_testing` is a real third verdict — "they want to try it again on a
 * different substrate" is neither approval nor rejection, and folding it into
 * pending would lose the fact that a trial happened at all.
 */
export function FeedbackScreen({
  workspace,
  rows,
  facets,
  verdicts,
  reviewedWithoutFeedback,
  anyFeedbackAtAll,
  cancellations,
  cancelReasons,
  filters,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  rows: TrialFeedbackRow[];
  facets: TrialFeedbackFacets;
  verdicts: TrialVerdicts;
  /** Samples marked reviewed with no §16 row behind them. A named gap. */
  reviewedWithoutFeedback: number;
  /** Whether this book has ever recorded a trial answer at all. */
  anyFeedbackAtAll: boolean;
  /**
   * The trials that were CALLED OFF, grouped by why.
   *
   * Deliberately NOT narrowed by this screen's three filters — those are all
   * properties of a trial that happened, and a cancelled one has none of them.
   * The section says so where it is drawn.
   */
  cancellations: TrialCancellations;
  /** `leads.sampleCancelReasons` — the words, from configuration. */
  cancelReasons: { code: string; label: string }[];
  filters: Selected;
}) {
  const filtered = Boolean(filters.product || filters.competitor || filters.outcome);

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />

      <ScreenHeader
        title="Trial feedback"
        subtitle="§16's seven answers across every trial: quality, performance, application, drying, the comparison, price, and the open box. “Good” cannot be read back — this is where “better drying than the incumbent, price is the problem” stops being a note on one record and becomes a pattern."
      />

      {reviewedWithoutFeedback ? (
        <Banner
          tone="info"
          title={`${plural(reviewedWithoutFeedback, "sample")} marked reviewed with no answers behind it`}
          body="Those trials were reviewed before §16's seven questions existed — they carry a verdict and at most one sentence, in the sample's own coarse columns, and nothing this library can group or count. They are not in the figures below. Their records still show what was written."
        />
      ) : null}

      {verdicts.pending ? (
        <Banner
          tone="warn"
          title={`${plural(verdicts.pending, "trial")} answered, with no verdict recorded`}
          body="Answers were written down and the sample's outcome is still pending. The two are written in one transaction, so this should be empty — it is drawn rather than hidden, because a row nobody can account for is worse than one that says why it is there."
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "They liked it",
            value: String(verdicts.approved),
            sub: share(verdicts.approved, verdicts.total),
            tone: "success",
          },
          {
            label: "They did not",
            value: String(verdicts.rejected),
            sub: share(verdicts.rejected, verdicts.total),
            tone: verdicts.rejected ? "danger" : undefined,
          },
          {
            label: "Want to test further",
            value: String(verdicts.moreTesting),
            sub: "a real third answer",
          },
          {
            label: filtered ? "Trials in this view" : "Trials answered",
            value: String(verdicts.total),
            sub: filtered ? `of ${facets.total} in all` : undefined,
          },
        ]}
      />

      {/* --------------------------------------------------------- the filters */}

      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        What was tried
      </div>
      <FilterChips
        current={filters.product ?? "all"}
        options={[
          { key: "all", label: "Every product", href: hrefFor(workspace, filters, { product: null }), count: facets.total },
          ...facets.products.map((p) => ({
            key: p.value,
            label: p.label,
            href: hrefFor(workspace, filters, { product: p.value }),
            count: p.count,
          })),
        ]}
      />

      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        What they were using before
      </div>
      <FilterChips
        current={filters.competitor ?? "all"}
        options={[
          { key: "all", label: "Anybody", href: hrefFor(workspace, filters, { competitor: null }), count: facets.total },
          ...facets.competitors.map((c) => ({
            key: c.value,
            label: c.label,
            href: hrefFor(workspace, filters, { competitor: c.value }),
            count: c.count,
          })),
        ]}
      />

      <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        The verdict
      </div>
      <FilterChips
        current={filters.outcome ?? "all"}
        options={[
          { key: "all", label: "Every verdict", href: hrefFor(workspace, filters, { outcome: null }) },
          { key: "approved", label: "They liked it", href: hrefFor(workspace, filters, { outcome: "approved" }) },
          { key: "rejected", label: "They did not", href: hrefFor(workspace, filters, { outcome: "rejected" }) },
          {
            key: "more_testing",
            label: "Want to test further",
            href: hrefFor(workspace, filters, { outcome: "more_testing" }),
          },
        ]}
      />

      <p className="mb-4 max-w-[760px] text-[12px] leading-[17px] text-muted">
        The competitor chips read the incumbent the lead named when it was raised —
        a stored value, which is what makes it countable.
        {facets.noCompetitor
          ? ` ${plural(facets.noCompetitor, "trial")} ${facets.noCompetitor === 1 ? "names" : "name"} nobody, so no chip can reach ${facets.noCompetitor === 1 ? "it" : "them"}.`
          : ""}
        {facets.noProduct
          ? ` ${plural(facets.noProduct, "trial")} ${facets.noProduct === 1 ? "names" : "name"} no product either — the request said what the customer asked for in words.`
          : ""}{" "}
        The COMPARISON itself is a sentence somebody wrote down and cannot be grouped,
        only read; it is the column that carries most of what a trial is worth.
      </p>

      {/* ------------------------------------------------------------ the rows */}

      {rows.length === 0 ? (
        anyFeedbackAtAll ? (
          <Empty
            title="Nothing matches this view"
            body="Trials have been recorded — none of them under these filters. Clear the product, the competitor or the verdict above to widen it."
            action={
              <Link
                href={leadHref(workspace, "samples/feedback")}
                className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Clear the filters
              </Link>
            }
          />
        ) : (
          <Empty
            title="No trial feedback recorded yet"
            body="A trial produces seven answers, and they are written down on the sample desk or on the review chase list once somebody has made the call. Nobody has made one yet."
          />
        )
      ) : (
        <Table
          minWidth={1180}
          head={
            <>
              <HeadCell width={240}>Customer</HeadCell>
              <HeadCell width={260}>What was tried</HeadCell>
              <HeadCell width={220}>Against what</HeadCell>
              <HeadCell width={190}>Verdict</HeadCell>
              <HeadCell width={170}>Recorded</HeadCell>
            </>
          }
        >
          {rows.flatMap((r, i) => [
            <Row key={`${r.sampleId}-head`} striped={i % 2 === 1}>
              <Cell truncate={240}>
                <Link href={leadHref(workspace, `samples/${r.sampleId}`)} className="no-underline">
                  {r.customerName}
                </Link>
                <span className="block truncate text-[12px] text-muted">
                  {[r.city, r.salesmanName].filter(Boolean).join(" · ") || "—"}
                </span>
              </Cell>
              <Cell truncate={260}>
                <span className="block truncate text-[13px] text-body">
                  {r.quantityCans ? `${plural(r.quantityCans, "can")} · ` : ""}
                  {r.productName ?? (
                    <span className="text-muted">no product named</span>
                  )}
                </span>
                <span className="block text-[12px] text-muted">
                  {sampleStateLabel(r.state as SampleState)}
                </span>
              </Cell>
              <Cell truncate={220}>
                {r.competitor ? (
                  <span className="text-[13px] text-body">{r.competitor}</span>
                ) : (
                  <span
                    className="text-muted"
                    title="Nobody wrote down what this shop was using. It is an absence, not a competitor called nothing."
                  >
                    Not recorded
                  </span>
                )}
              </Cell>
              <Cell>
                <Pill tone={verdictTone(r.trialOutcome)}>{verdictWord(r.trialOutcome)}</Pill>
              </Cell>
              <Cell truncate={170}>
                <span className="block text-[13px] text-body">
                  {r.recordedOn ? shortDate(r.recordedOn) : "—"}
                </span>
                <span className="block truncate text-[12px] text-muted">
                  {r.recordedByName ?? "author not recorded"}
                </span>
              </Cell>
            </Row>,

            /* The seven, under the row they belong to rather than as seven more
               columns: a table wide enough for all of them is one nobody reads
               either half of, and every answer here is a sentence. */
            <Row key={`${r.sampleId}-answers`} striped={i % 2 === 1}>
              <Cell colSpan={5} className="pt-0">
                <Answers row={r} />
              </Cell>
            </Row>,
          ])}
        </Table>
      )}

      <CalledOff cancellations={cancellations} reasons={cancelReasons} />
    </div>
  );
}

/**
 * THE TRIALS THAT NEVER HAPPENED, and why — the other half of this screen.
 *
 * The library above is every trial that produced an answer, which is the half
 * that went well. A cancelled sample produces no `sample_feedback` row at all —
 * it is by definition the trial that did not run — so no filter on that table
 * could ever reach one, and until this section existed the entire cost of a
 * cancellation was invisible on the one screen where anybody looks at trials in
 * bulk. Stock was written off one row at a time, each with a sentence nobody
 * could add up.
 *
 * **It is three problems, and that is why it is drawn in three groups.** Mahek's
 * eight codes exist to separate a SUPPLY problem — a product we could not
 * source — from a CUSTOMER problem — a shop that went quiet or changed its mind
 * — from a SALES problem, which is the price. All three read as "trial
 * cancelled" in a free-text column, each is somebody else's to fix, and
 * "cancelled: 14" was a number that sent nobody anywhere. Grouping them is what
 * turns the count into a destination.
 *
 * **It sits BELOW the library rather than beside the verdicts**, because the
 * filters in between do not reach it and a block that ignored the filter
 * directly under the filter row would read as a bug on every click. The heading
 * says it is the whole book.
 *
 * **A cancellation with no code is drawn, counted and named.** Every one
 * recorded before the eight existed carries none, and so does every one a
 * handset in the field sends — an APK cannot be recalled and the sync endpoint
 * takes a cancellation without a code rather than losing a trial somebody
 * really called off. Nothing backfills them: reading an old sentence into one
 * of eight is guessing which of eight somebody meant. Left out they would make
 * the groups add up to less than the total with nothing saying why, which is
 * the one thing a count on a reporting screen must never do.
 */
function CalledOff({
  cancellations,
  reasons,
}: {
  cancellations: TrialCancellations;
  reasons: { code: string; label: string }[];
}) {
  const { total, uncoded } = cancellations;

  /* Nothing has been called off, so there is nothing to explain. An empty
     table under a heading about supply and sales problems would invite
     somebody to read a book with no cancellations as a screen that lost
     them. */
  if (!total) return null;

  const groups: {
    key: SampleCancelProblem | "unstated";
    label: string;
    whose: string;
    rows: { label: string; count: number }[];
    count: number;
  }[] = [
    ...(["supply", "customer", "sales"] as const).map((key) => ({
      key,
      label: SAMPLE_CANCEL_PROBLEM_LABELS[key].label,
      whose: SAMPLE_CANCEL_PROBLEM_LABELS[key].whose,
      rows: [] as { label: string; count: number }[],
      count: 0,
    })),
    {
      key: "unstated" as const,
      label: "Not one of the three",
      whose:
        "“Other”, a code nobody has grouped, and every cancellation recorded before the list existed.",
      rows: [] as { label: string; count: number }[],
      count: 0,
    },
  ];

  const find = (key: SampleCancelProblem | "unstated") =>
    groups.find((g) => g.key === key)!;

  for (const r of cancellations.reasons) {
    const group = find(sampleCancelProblemOf(r.code) ?? "unstated");
    /* `labelOf` falls back to the code itself, which is right: a code the
       configured list no longer carries still describes cancellations that
       really happened, and printing the raw code is honest where inventing a
       label would not be. */
    group.rows.push({ label: labelOf(reasons, r.code), count: r.count });
    group.count += r.count;
  }
  if (uncoded) {
    const group = find("unstated");
    group.rows.push({ label: "No reason recorded", count: uncoded });
    group.count += uncoded;
  }

  return (
    <div className="mt-8">
      <ScreenHeader
        title="Trials called off"
        subtitle="Every cancelled sample in this book — not narrowed by the filters above, which describe trials that happened. A product we could not source, a shop that stopped answering and a price objection all read as “cancelled”, and each one is somebody else's to fix; this is the count that says which."
      />

      <MetricRow
        metrics={groups
          .filter((g) => g.count || g.key !== "unstated")
          .map((g) => ({
            label: g.label,
            value: String(g.count),
            sub: share(g.count, total),
            tone: undefined,
          }))}
      />

      <Table
        minWidth={620}
        head={
          <>
            <HeadCell width={220}>Whose problem</HeadCell>
            <HeadCell width={300}>Why it was called off</HeadCell>
            <HeadCell width={100}>Trials</HeadCell>
          </>
        }
      >
        {groups
          .filter((g) => g.rows.length)
          .flatMap((g, gi) =>
            g.rows
              .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
              .map((row, ri) => (
                <Row key={`${g.key}-${row.label}`} striped={gi % 2 === 1}>
                  <Cell truncate={220}>
                    {/* The group is named once, on its first row, and the rows
                        under it are indented by being blank rather than by a
                        rule: repeating "Customer" four times down a column is
                        four words nobody reads. */}
                    {ri === 0 ? (
                      <>
                        <span className="block text-[13px] text-body">{g.label}</span>
                        <span className="block text-[12px] text-muted">{g.whose}</span>
                      </>
                    ) : null}
                  </Cell>
                  <Cell truncate={300}>
                    <span className="text-[13px] text-body">{row.label}</span>
                  </Cell>
                  <Cell>
                    <span className="text-[13px] text-body">{row.count}</span>
                  </Cell>
                </Row>
              )),
          )}
      </Table>

      {uncoded ? (
        <p className="mt-2 max-w-[760px] text-[12px] leading-[17px] text-muted">
          {plural(uncoded, "cancellation")} {uncoded === 1 ? "carries" : "carry"} no code — every
          one recorded before the list existed, and every one a handset sends without one, which
          the office accepts rather than losing a trial somebody really called off. Nothing reads
          an old sentence into one of eight: that would be guessing which of eight somebody meant
          months later. Their remarks are still on their own records.
        </p>
      ) : null}
    </div>
  );
}

/**
 * §16's seven, in the order it asks them, with the unanswered ones named.
 *
 * `FEEDBACK_FIELDS` is the list — the same one the form writes from, so a
 * question added there appears here without anybody remembering to add it.
 */
function Answers({ row }: { row: TrialFeedbackRow }) {
  const said = FEEDBACK_FIELDS.map((f) => ({
    label: f.label,
    value: (row[f.id as keyof TrialFeedbackRow] as string | null)?.trim() || null,
  }));
  const answered = said.filter((s) => s.value);
  const blank = said.filter((s) => !s.value);

  return (
    <div className="max-w-[1100px] pb-1">
      <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 md:grid-cols-2">
        {answered.map((s) => (
          <div key={s.label} className="flex gap-2 text-[13px] leading-[18px]">
            <span className="w-[150px] flex-none text-muted">{s.label}</span>
            <span className="min-w-0 text-pretty text-body">{s.value}</span>
          </div>
        ))}
      </div>
      {blank.length ? (
        <p className="mt-1.5 text-[12px] text-muted">
          Nothing was said about {listWords(blank.map((b) => b.label.toLowerCase()))} — which is
          not the same as nothing to say, and is why the blanks are named rather than dropped.
        </p>
      ) : null}
    </div>
  );
}

/** "quality, drying and price" — an Oxford-less list, read aloud-able. */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function verdictWord(outcome: string): string {
  return outcome === "approved"
    ? "They liked it"
    : outcome === "rejected"
      ? "They did not"
      : outcome === "more_testing"
        ? "Testing further"
        : "No verdict yet";
}

function verdictTone(outcome: string): "success" | "danger" | "brand" | "warn" {
  return outcome === "approved"
    ? "success"
    : outcome === "rejected"
      ? "danger"
      : outcome === "more_testing"
        ? "brand"
        : "warn";
}

/** A percentage of a total that may be zero. Never "NaN%" on an empty book. */
function share(part: number, whole: number): string | undefined {
  if (!whole) return undefined;
  return `${Math.round((part / whole) * 100)}% of ${whole}`;
}

/**
 * This screen's URL with one filter changed and the rest kept.
 *
 * Built by hand rather than from `URLSearchParams` over the incoming request,
 * because what belongs in the link is the THREE filters this screen owns — a
 * stray parameter carried through would survive every click and there would be
 * nothing on the screen saying it was there.
 */
function hrefFor(
  workspace: LeadWorkspace,
  current: Selected,
  change: Partial<Selected>,
): string {
  const next = { ...current, ...change };
  const parts: string[] = [];
  if (next.product) parts.push(`product=${encodeURIComponent(next.product)}`);
  if (next.competitor) parts.push(`competitor=${encodeURIComponent(next.competitor)}`);
  if (next.outcome) parts.push(`outcome=${encodeURIComponent(next.outcome)}`);
  return parts.length ? leadHref(workspace, `samples/feedback?${parts.join("&")}`) : leadHref(workspace, "samples/feedback");
}
