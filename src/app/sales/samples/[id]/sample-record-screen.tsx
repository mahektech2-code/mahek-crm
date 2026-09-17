import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { shortDate, stamp } from "@/lib/format";
import {
  FEEDBACK_FIELDS,
  SAMPLE_REASONS,
  labelOf,
  sampleStateLabel,
  type SampleState,
} from "@/lib/lead-labels";
import type { SampleDeskRow, SampleFeedbackRow } from "@/lib/services/sample-service";
import type { SampleTrialFacts } from "@/lib/services/sample-trials-service";
import { Banner, Empty, Pill, ScreenHeader } from "../../parts";
import { plural } from "../../words";

/**
 * The journey, in the order it is walked.
 *
 * `rejected` and `cancelled` are deliberately NOT rungs on it: they are
 * off-ramps, and drawing them as a seventh and eighth step would say a refused
 * request is further along than an approved one. A sample that took one of
 * them is drawn as having stopped where it stopped, with the reason beside it.
 */
const JOURNEY: readonly { state: SampleState; asserts: string }[] = [
  { state: "requested", asserts: "The salesman asked, standing in the shop." },
  { state: "approved", asserts: "Somebody at a desk said yes. Nothing goes out without it." },
  { state: "dispatched", asserts: "We say it left." },
  { state: "received", asserts: "The shop says it is in their hands." },
  { state: "trial_done", asserts: "They have used it. What they thought is still unknown." },
  { state: "reviewed", asserts: "Somebody asked, and wrote down the seven answers." },
];

type Approval = {
  id: string;
  state: string;
  stepIndex: number;
  approverUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
} | null;

/**
 * One sample, whole — screen 26.
 *
 * **THE THREE DATES ARE THREE PARTIES' WORDS, and this screen says so out
 * loud.** `dispatched_at` is OURS, `delivered_at` is the carrier's or our own
 * man's, and `received_at` is THE SHOP's. No two of them are the same fact,
 * §J turns entirely on the third — "sample received Yes/No; if No the
 * follow-up remains pending" — and a single delivery date could never answer
 * it. `received_at` is never defaulted from `delivered_at` and is never drawn
 * as though it had been: where the shop has not confirmed, the row says the
 * shop has not confirmed, however firmly the courier's tracking says otherwise.
 *
 * **The gap between the two trial dates is drawn, not implied.** A trial
 * started and never finished is the commonest way a sample goes quiet, and it
 * is invisible where the only column is an outcome.
 *
 * **The review window is dated from confirmed receipt and the screen names
 * which date it is counting from.** Not from dispatch — that is the whole
 * reason the third date exists.
 *
 * A read-only server component. Every write this record can take lives on the
 * sample desk and on the review chase list, where somebody has just made the
 * call.
 */
export function SampleRecordScreen({
  sample,
  approval,
  feedback,
  facts,
  ladder,
  chaseNumber,
  nextChaseOn,
  chaseOverdue,
  trialOpenDays,
  trialRanDays,
  today,
}: {
  sample: SampleDeskRow;
  approval: Approval;
  feedback: SampleFeedbackRow | null;
  facts: SampleTrialFacts;
  ladder: number[];
  chaseNumber: number;
  nextChaseOn: string | null;
  chaseOverdue: boolean;
  /** Started and not finished — days and counting. The quiet one. */
  trialOpenDays: number | null;
  /** Started and finished — how long it actually ran. */
  trialRanDays: number | null;
  today: string;
}) {
  const stopped = sample.state === "rejected" || sample.state === "cancelled";
  const reachedIndex = JOURNEY.findIndex((j) => j.state === sample.state);

  return (
    <div className="p-6">
      <ScreenHeader
        title={sample.customerName || "Sample"}
        subtitle={`${sample.quantityCans ? `${plural(sample.quantityCans, "can")} of ` : ""}${sample.productName ?? "a product nobody named"}${sample.salesmanName ? ` · asked for by ${sample.salesmanName}` : ""}${sample.city ? ` · ${sample.city}` : ""}`}
        actions={
          <>
            <Link
              href={`/sales/leads/${sample.customerId}`}
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              The lead →
            </Link>
            <Link
              href="/sales/samples/desk"
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              Sample desk
            </Link>
          </>
        }
      />

      {sample.state === "rejected" ? (
        <Banner
          tone="danger"
          title="This request was refused"
          body={
            approval?.decisionNote?.trim()
              ? `“${approval.decisionNote.trim()}”`
              : "No reason was recorded against the refusal. A refused sample has to say why — the same rule as a lost lead, and for the same reason: the next request goes out exactly the same otherwise."
          }
        />
      ) : null}

      {sample.state === "cancelled" ? (
        <Banner
          tone="warn"
          title="This sample was cancelled"
          body={
            facts.cancelReason?.trim()
              ? `“${facts.cancelReason.trim()}”${facts.cancelledAt ? ` — ${stamp(facts.cancelledAt)}` : ""}`
              : "No reason was recorded. Cancelling is what ends the chase loop without an answer, so the reason is the only record of why nobody ever found out what they thought."
          }
        />
      ) : null}

      {trialOpenDays !== null ? (
        <Banner
          tone="warn"
          title={`A trial started ${plural(trialOpenDays, "day")} ago and has not finished`}
          body="The gap between started and completed is the point of there being two columns. A trial that began and was never finished is the commonest way a sample goes quiet — and where the only column is an outcome, it looks exactly like one nobody has got round to yet."
        />
      ) : null}

      {/* ------------------------------------------------------- the journey */}

      <Section
        title="Where it has got to"
        note="The state is set by the person doing the step. It is derived from nothing, so every date below has a name against it."
      >
        <ol className="flex flex-wrap gap-x-1 gap-y-2">
          {JOURNEY.map((step, i) => {
            const reached = !stopped && reachedIndex >= 0 && i <= reachedIndex;
            const current = !stopped && i === reachedIndex;
            return (
              <li key={step.state} className="flex items-center gap-1" title={step.asserts}>
                <span
                  className={cx(
                    "inline-flex h-7 items-center rounded-[4px] border px-2.5 text-[12px] whitespace-nowrap",
                    current
                      ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                      : reached
                        ? "border-line bg-surface text-body"
                        : "border-dashed border-line bg-canvas text-muted",
                  )}
                >
                  {sampleStateLabel(step.state)}
                </span>
                {i < JOURNEY.length - 1 ? (
                  <span aria-hidden className="text-[12px] text-muted">
                    →
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
        {stopped ? (
          <p className="mt-2 text-[13px] text-body">
            It stopped: <Pill tone="danger">{sampleStateLabel(sample.state)}</Pill>. Refusing and
            cancelling are off the ladder rather than further along it — a refused request is not
            nearer an answer than an approved one.
          </p>
        ) : (
          <p className="mt-2 text-[13px] text-muted">
            {JOURNEY[reachedIndex]?.asserts ?? "This sample carries a state nothing here draws."}
          </p>
        )}
      </Section>

      {/* ---------------------------------------------------- the three dates */}

      <Section
        title="The three dates"
        note="Three parties assert three different things, and no two of them are the same fact. This is the same discipline payment receipts keep for money, one module over."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <DateCard
            party="We say"
            what="It left us"
            column="dispatched_at"
            at={sample.dispatchedAt}
            by={facts.dispatchedByName}
            missing="Not sent yet. Approved stock still in the godown is an opportunity nobody took."
            extra={
              sample.dispatchedAt
                ? [sample.courierName ?? "courier not named", sample.trackingNumber ?? "no docket"]
                    .filter(Boolean)
                    .join(" · ")
                : null
            }
          />
          <DateCard
            party="The carrier says"
            what="It arrived"
            column="delivered_at"
            at={facts.deliveredAt}
            by={null}
            missing="Nothing has said it landed. Equal to the dispatch date where the salesman handed it over standing in the shop; days apart where it went on a lorry, and that gap is the only thing that says whether transport is the problem."
            extra={
              sample.expectedDeliveryDate
                ? `promised ${shortDate(sample.expectedDeliveryDate)}`
                : "nothing was promised"
            }
          />
          <DateCard
            party="The SHOP says"
            what="It is in our hands"
            column="received_at"
            at={sample.receivedAt}
            by={facts.receivedReportedByName}
            tone="brand"
            missing="The customer has not confirmed it. §J turns entirely on this — sample received Yes/No, and if No the follow-up stays pending — so it stays open however firmly the courier's tracking says otherwise."
            extra={null}
          />
        </div>
        <p className="mt-2 max-w-[820px] text-[12px] leading-[17px] text-muted">
          <strong className="font-medium text-body">
            The third is never derived from the second.
          </strong>{" "}
          A default there would quietly assert something nobody asked the customer — and it is the
          one date the whole review window is measured from, so a guess would put a call on
          somebody&rsquo;s list about a parcel that never arrived.
        </p>
      </Section>

      {/* ------------------------------------------------------------ the trial */}

      <Section
        title="The trial"
        note="Two columns, and the gap between them is the point."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <DateCard
            party="§K"
            what="Trial started"
            column="trial_started_at"
            at={facts.trialStartedAt}
            by={null}
            missing="Nobody has recorded them starting. The sample may be on a shelf."
            extra={null}
          />
          <DateCard
            party="§K"
            what="Trial completed"
            column="trial_completed_at"
            at={facts.trialCompletedAt}
            by={null}
            tone={trialOpenDays !== null ? "warn" : undefined}
            missing={
              facts.trialStartedAt
                ? "Started and never finished. This is the state the two columns exist to make visible."
                : "Nothing to complete — the trial has not been recorded as started."
            }
            extra={null}
          />
        </div>
        <p className="mt-2 text-[13px] text-body">
          {trialRanDays !== null
            ? `It ran ${plural(trialRanDays, "day")}.`
            : trialOpenDays !== null
              ? `Open ${plural(trialOpenDays, "day")} and counting, measured to ${shortDate(today)}.`
              : "No trial dates are recorded against this sample, so nothing here can say whether it was ever tried."}
        </p>
      </Section>

      {/* ---------------------------------------------------- the review window */}

      <Section
        title="The review"
        note="§16 does not stop. The last interval repeats until there is an answer, because a trial nobody reviewed is stock given away for nothing."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Fact
            label="Asked so far"
            value={
              sample.reviewChaseCount
                ? plural(sample.reviewChaseCount, "time")
                : "Not yet asked"
            }
            sub={
              sample.lastReviewChaseAt
                ? `last ${stamp(sample.lastReviewChaseAt)}`
                : "no chase recorded"
            }
            tone={sample.reviewChaseCount > ladder.length ? "danger" : undefined}
          />
          <Fact
            label="Counted from"
            value={facts.receivedOn ? shortDate(facts.receivedOn) : "Nothing to count from"}
            sub={
              facts.receivedOn
                ? "confirmed receipt — the shop's own word, not our dispatch"
                : "the shop has not confirmed it arrived, so no chase can be dated"
            }
            tone={facts.receivedOn ? undefined : "warn"}
          />
          <Fact
            label={`Ask ${chaseNumber}`}
            value={nextChaseOn ? shortDate(nextChaseOn) : "—"}
            sub={
              nextChaseOn
                ? chaseOverdue
                  ? "due, and not yet made"
                  : "not due yet"
                : "no date the ladder can produce"
            }
            tone={chaseOverdue ? "warn" : undefined}
          />
        </div>
        <p className="mt-2 max-w-[820px] text-[12px] leading-[17px] text-muted">
          The ladder in force is{" "}
          {ladder.length
            ? `day ${ladder.join(", then ")}, and then the last interval again, and again`
            : "daily — no ladder is configured"}
          . It is dated from CONFIRMED RECEIPT rather than from dispatch: a review timed from the
          day we posted it rings a customer still waiting for the parcel, and that call teaches
          them we do not know where our own stock is.
          {sample.reviewChaseCount > ladder.length && ladder.length
            ? " This one is past the end of the ladder — nothing new is being scheduled, the last interval is simply repeating."
            : ""}
        </p>
      </Section>

      {/* ---------------------------------------------------------- the verdict */}

      <Section
        title="The verdict"
        note="The state is the journey and the verdict is what they thought. With one column, a sample approved three weeks ago and never dispatched looked identical to one under evaluation."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={verdictTone(facts.trialOutcome)}>{verdictWord(facts.trialOutcome)}</Pill>
          {facts.reviewedAt ? (
            <span className="text-[13px] text-muted">
              recorded {stamp(facts.reviewedAt)}
              {facts.reviewedByName ? ` by ${facts.reviewedByName}` : ""}
            </span>
          ) : null}
        </div>
        {facts.trialOutcome === "more_testing" ? (
          <p className="mt-2 max-w-[820px] text-[13px] text-body">
            A real third answer rather than a shrug: they want to try it again on a different
            substrate, which is neither approval nor rejection. Filed as pending it would lose the
            fact that a trial happened at all.
          </p>
        ) : null}
        {facts.trialOutcome === "rejected" ? (
          facts.rejectionReason?.trim() ? (
            <p className="mt-2 max-w-[820px] rounded-[6px] border-l-[3px] border-danger bg-danger-soft px-3 py-2 text-[13px] text-body">
              <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Why it was refused
              </span>
              “{facts.rejectionReason.trim()}”
            </p>
          ) : (
            <p className="mt-2 max-w-[820px] text-[13px] text-danger">
              A rejected trial with no reason on it. The rule is the same as a lost lead and an On
              Hold — the next sample goes out exactly the same otherwise — and this row predates
              it or was written by a path that did not ask.
            </p>
          )
        ) : null}
        {facts.satisfaction?.trim() ? (
          <p className="mt-2 max-w-[820px] text-[13px] text-muted">
            Coarse column, kept in step for main&rsquo;s own sample screens:{" "}
            <span className="text-body">“{facts.satisfaction.trim()}”</span>
          </p>
        ) : null}
        {facts.additionalRequirement?.trim() ? (
          <p className="mt-2 max-w-[820px] text-[13px] text-body">
            <span className="text-muted">What else they asked for while we had their attention:</span>{" "}
            {facts.additionalRequirement.trim()}
          </p>
        ) : null}
      </Section>

      {/* ------------------------------------------------ §16's seven answers */}

      <Section
        title="What they said"
        note="Seven answers rather than one box. “Good” cannot be read back six weeks later as “better drying than what they use, price is the problem” — and that sentence is what the negotiation call needs."
      >
        {feedback ? (
          <>
            <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
              {FEEDBACK_FIELDS.map((f) => {
                const value =
                  (feedback[f.id as keyof SampleFeedbackRow] as string | null)?.trim() || null;
                return (
                  <div key={f.id} className="flex gap-3 text-[13px] leading-[18px]">
                    <span className="w-[160px] flex-none text-muted">{f.label}</span>
                    <span className={cx("min-w-0 text-pretty", value ? "text-body" : "text-muted")}>
                      {value ?? "Nothing said"}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[12px] text-muted">
              Recorded{" "}
              {feedback.recordedAt ? stamp(feedback.recordedAt) : "at a time nothing recorded"}
              {feedback.recordedByName ? ` by ${feedback.recordedByName}` : ""}. One row per
              sample — a second opinion is a second sample, so this cannot be overwritten.
            </p>
          </>
        ) : (
          <Empty
            title="Nobody has written down what they thought"
            body={
              sample.receivedAt
                ? "The sample is with the customer and the seven questions have not been asked. That is what the review chase list exists for, and the chase count above says how many times somebody has been told to make the call."
                : "The seven questions are asked once the shop has the sample and has used it. It is not there yet."
            }
          />
        )}
        {facts.feedbackNotes?.trim() ? (
          <p className="mt-3 max-w-[820px] text-[13px] text-muted">
            An older free-text note sits on the sample as well:{" "}
            <span className="text-body">“{facts.feedbackNotes.trim()}”</span>
          </p>
        ) : null}
      </Section>

      {/* ------------------------------------------------------ what it was for */}

      <Section
        title="What was asked for, and why"
        note="The reason is a code, so “how many trials did we run to compare against a competitor this quarter” is a question somebody can ask rather than a grep over free text."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Fact
            label="Why they wanted one"
            value={labelOf(SAMPLE_REASONS, sample.reasonCode)}
            sub={sample.reasonCode ? undefined : "no reason code recorded"}
          />
          <Fact
            label="What it is for"
            value={sample.application ?? "Not stated"}
            sub={sample.application ? undefined : "without it, a trial means very little"}
          />
          <Fact
            label="Quantity"
            value={sample.quantityCans ? plural(sample.quantityCans, "can") : "Not stated"}
            sub="cans, like every quantity here — litres come off the SKU's own packing"
          />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Fact
            label="Asked on"
            value={sample.requestedDate ? shortDate(sample.requestedDate) : "—"}
            sub={facts.leadStageAtRequest ? `the lead was at ${facts.leadStageAtRequest}` : undefined}
          />
          <Fact
            label="Approved"
            value={sample.approvedAt ? shortDate(sample.approvedAt) : "Not approved"}
            sub={
              facts.approvedByName
                ? `by ${facts.approvedByName}`
                : approval
                  ? `approval ${approval.state}`
                  : "no approval row — raised before the approvals path existed, or never looked at"
            }
          />
          <Fact
            label="Became an order"
            value={facts.convertedOrderId ? "Yes" : "Not yet"}
            sub={
              facts.convertedOrderId
                ? "the conversion report is this column"
                : "a trial is not a sale until one is placed"
            }
            tone={facts.convertedOrderId ? "success" : undefined}
          />
        </div>
        {facts.followUpDate ? (
          <p className="mt-3 text-[13px] text-muted">
            A follow-up is dated {shortDate(facts.followUpDate)}.
          </p>
        ) : null}
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ the parts */

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded-[6px] border border-line bg-surface px-4 py-3.5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {note ? (
        <p className="mt-0.5 mb-3 max-w-[820px] text-[12px] leading-[17px] text-pretty text-muted">
          {note}
        </p>
      ) : (
        <div className="mb-3" />
      )}
      {children}
    </section>
  );
}

/**
 * One date, with the PARTY that asserted it named above it.
 *
 * The party is the heading rather than a footnote, because the whole reason
 * there are three of these is that they are three different people's words and
 * a reader who takes them for one fact recorded three times will read the
 * carrier's tracking as the customer's confirmation.
 */
function DateCard({
  party,
  what,
  column,
  at,
  by,
  missing,
  extra,
  tone,
}: {
  party: string;
  what: string;
  column: string;
  at: string | null;
  by: string | null;
  missing: string;
  extra: string | null;
  tone?: "brand" | "warn";
}) {
  return (
    <div
      className={cx(
        "rounded-[6px] border bg-canvas px-3 py-2.5",
        tone === "brand" ? "border-brand" : tone === "warn" ? "border-warn" : "border-line",
      )}
    >
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{party}</div>
      <div className="mt-0.5 text-[13px] font-medium text-ink">{what}</div>
      {at ? (
        <>
          <div className="mt-1 text-[15px] text-ink">{stamp(at)}</div>
          {by ? <div className="text-[12px] text-muted">reported by {by}</div> : null}
          {extra ? <div className="text-[12px] text-muted">{extra}</div> : null}
        </>
      ) : (
        <p className="mt-1 text-[12px] leading-[17px] text-pretty text-muted">{missing}</p>
      )}
      <div className="mt-1.5 font-mono text-[10px] text-muted">{column}</div>
    </div>
  );
}

function Fact({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "danger" | "warn" | "success";
}) {
  return (
    <div className="rounded-[6px] border border-line bg-canvas px-3 py-2.5">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</div>
      <div
        className={cx(
          "mt-0.5 text-[15px] font-medium",
          tone === "danger"
            ? "text-danger"
            : tone === "warn"
              ? "text-warn-ink"
              : tone === "success"
                ? "text-success"
                : "text-ink",
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[12px] text-pretty text-muted">{sub}</div> : null}
    </div>
  );
}

function verdictWord(outcome: string): string {
  return outcome === "approved"
    ? "They liked it"
    : outcome === "rejected"
      ? "They did not"
      : outcome === "more_testing"
        ? "They want to test it further"
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
