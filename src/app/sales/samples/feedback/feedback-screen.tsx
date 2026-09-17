import Link from "next/link";
import { shortDate } from "@/lib/format";
import { FEEDBACK_FIELDS, sampleStateLabel, type SampleState } from "@/lib/lead-labels";
import type {
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
} from "../../parts";
import { plural } from "../../words";

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
  rows,
  facets,
  verdicts,
  reviewedWithoutFeedback,
  anyFeedbackAtAll,
  filters,
}: {
  rows: TrialFeedbackRow[];
  facets: TrialFeedbackFacets;
  verdicts: TrialVerdicts;
  /** Samples marked reviewed with no §16 row behind them. A named gap. */
  reviewedWithoutFeedback: number;
  /** Whether this book has ever recorded a trial answer at all. */
  anyFeedbackAtAll: boolean;
  filters: Selected;
}) {
  const filtered = Boolean(filters.product || filters.competitor || filters.outcome);

  return (
    <div className="p-6">
      <LeadTabs />

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
          { key: "all", label: "Every product", href: hrefFor(filters, { product: null }), count: facets.total },
          ...facets.products.map((p) => ({
            key: p.value,
            label: p.label,
            href: hrefFor(filters, { product: p.value }),
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
          { key: "all", label: "Anybody", href: hrefFor(filters, { competitor: null }), count: facets.total },
          ...facets.competitors.map((c) => ({
            key: c.value,
            label: c.label,
            href: hrefFor(filters, { competitor: c.value }),
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
          { key: "all", label: "Every verdict", href: hrefFor(filters, { outcome: null }) },
          { key: "approved", label: "They liked it", href: hrefFor(filters, { outcome: "approved" }) },
          { key: "rejected", label: "They did not", href: hrefFor(filters, { outcome: "rejected" }) },
          {
            key: "more_testing",
            label: "Want to test further",
            href: hrefFor(filters, { outcome: "more_testing" }),
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
                href="/sales/samples/feedback"
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
                <Link href={`/sales/samples/${r.sampleId}`} className="no-underline">
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
function hrefFor(current: Selected, change: Partial<Selected>): string {
  const next = { ...current, ...change };
  const parts: string[] = [];
  if (next.product) parts.push(`product=${encodeURIComponent(next.product)}`);
  if (next.competitor) parts.push(`competitor=${encodeURIComponent(next.competitor)}`);
  if (next.outcome) parts.push(`outcome=${encodeURIComponent(next.outcome)}`);
  return parts.length ? `/sales/samples/feedback?${parts.join("&")}` : "/sales/samples/feedback";
}
