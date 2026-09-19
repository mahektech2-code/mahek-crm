import { type LeadWorkspace } from "@/lib/lead-workspace";
import { notFound } from "next/navigation";
import { addDays, daysBetween, type BusinessDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { chaseOffset } from "@/lib/engines/lead-nurture";
import { sampleDetail } from "@/lib/services/sample-service";
import { sampleTrialFacts } from "@/lib/services/sample-trials-service";
import { SampleRecordScreen } from "@/components/samples/record/sample-record-screen";


/**
 * One sample, end to end.
 *
 * The desk is a worklist and this is a HISTORY, which is why it is a separate
 * screen rather than an expanding row: the three dates, the two trial dates,
 * the verdict, the reason a refusal carried and §16's seven answers are not
 * columns, and putting them in a drawer would give somebody six inches to read
 * a trial's whole life through.
 *
 * **Two reads of one row, and that is deliberate.** `sampleDetail` is the
 * desk's own shape, shared by four worklists, and `sampleTrialFacts` is
 * everything it does not carry. Widening the first to suit this page would put
 * fifteen columns nobody uses on every row of four tables; this is the one
 * screen that wants all of them. Both are narrowed identically, so a sample
 * the desk will not show cannot be read here either.
 *
 * **The chase arithmetic runs on the server, on business dates.** The ladder
 * is dated from CONFIRMED RECEIPT — the shop's own word — and the day parts it
 * needs come out of Postgres with the zone named rather than being sliced off
 * an instant here.
 */
export async function Body({
  workspace,
  params,
}: {
  workspace: LeadWorkspace;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const day = await today();

  const [detail, facts, config] = await Promise.all([
    sampleDetail(id),
    sampleTrialFacts(id),
    getConfig(),
  ]);

  /* Null covers both "no such sample" and "not in this person's book", and the
     two are deliberately the same answer: a 404 that told them apart would
     make the URL a way of finding out whose book an id belongs to. */
  if (!detail || !facts) notFound();

  const ladder = config["leads.sampleReviewChaseDays"];
  const chaseNumber = Math.max(0, detail.sample.reviewChaseCount) + 1;

  /*
   * THE REVIEW WINDOW RUNS FROM CONFIRMED RECEIPT, and the screen is told
   * which date that is rather than being left to imply it. Timed from dispatch
   * it would ring a customer still waiting for the parcel, and that call
   * teaches them we do not know where our own stock is.
   */
  const nextChaseOn = facts.receivedOn
    ? addDays(facts.receivedOn, chaseOffset(ladder, chaseNumber))
    : null;

  /*
   * §K — the gap, which is the point. A trial started and never finished is
   * the commonest way a sample goes quiet, and it is invisible where the only
   * column is an outcome. Measured in whole business days between two day
   * parts, never between two instants in the reader's own zone.
   */
  const trialDays = gap(facts.trialStartedOn, facts.trialCompletedOn ?? (day as BusinessDate));

  return (
    <SampleRecordScreen workspace={workspace}
      sample={detail.sample}
      approval={detail.approval}
      feedback={detail.feedback}
      facts={facts}
      /* The words behind the cancellation code, read from configuration so a
         reworded option reads with its new wording rather than with whatever
         the literal in `lead-labels.ts` happened to say when this shipped. */
      cancelReasons={config["leads.sampleCancelReasons"]}
      ladder={[...ladder]}
      chaseNumber={chaseNumber}
      nextChaseOn={nextChaseOn}
      chaseOverdue={nextChaseOn !== null && nextChaseOn <= day}
      trialOpenDays={facts.trialStartedOn && !facts.trialCompletedOn ? trialDays : null}
      trialRanDays={facts.trialStartedOn && facts.trialCompletedOn ? trialDays : null}
      today={day}
    />
  );
}

function gap(from: BusinessDate | null, to: BusinessDate | null): number | null {
  if (!from || !to) return null;
  return Math.max(0, daysBetween(from, to));
}
