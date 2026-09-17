import { type LeadWorkspace } from "@/lib/lead-workspace";
import { getConfig } from "@/lib/config/store";
import { addDays, daysBetween } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { chaseOffset, sampleChaseDue } from "@/lib/engines/lead-nurture";
import { samplesAwaitingReview } from "@/lib/services/sample-service";
import { sampleChaseDays } from "@/lib/services/sample-trials-service";
import { ChasesScreen, type ChaseRow } from "@/components/samples/chases/chases-screen";


/**
 * §16 — the chase that does not stop.
 *
 * A sample review is asked for on day 2, then 4, then 6, and past the end of
 * the ladder THE LAST INTERVAL REPEATS: 8, 10, 12, and on, until somebody has
 * an answer. That is the rule rather than an oversight — a trial nobody
 * reviewed is stock given away for nothing, and a ladder that gave up after
 * three attempts would quietly convert every hard-to-reach customer into a
 * write-off with no decision recorded anywhere.
 *
 * So this screen has no bottom. What it has instead is a COUNT: "asked three
 * times" is the number that tells a manager to stop raising tasks and ring the
 * shop themselves, and it is the column everything here is sorted by.
 *
 * **It is one read, not a second opinion.** `samplesAwaitingReview()` is the
 * sample desk's own "Awaiting review" tab, and this screen asks it the same
 * question rather than a similar one — two reads of "what is waiting on an
 * answer" is how two screens come to disagree about one trial. What is added
 * on top is the ENGINE: `chaseOffset` and `sampleChaseDue`, the same two
 * functions the nightly pass runs, so the desk, the job and this screen can
 * never name three different days for one ask.
 *
 * **The arithmetic runs here, on the server.** It is pure and it could run in
 * the browser, but the day it needs is the business's own day and a client
 * component may not read the clock during render — a date that changes between
 * renders is a date nobody can act on.
 */
export async function Body({
  workspace,
}: {
  workspace: LeadWorkspace;
}) {
  const day = await today();
  const [waiting, config] = await Promise.all([samplesAwaitingReview(300), getConfig()]);
  const ladder = config["leads.sampleReviewChaseDays"];

  /* The day parts, with the zone named. `sampleChaseDue` takes business dates
     and the table holds instants, and an instant is not a wall-clock day until
     something names the midnight. */
  const days = await sampleChaseDays(waiting.map((s) => s.id));

  const rows: ChaseRow[] = waiting.map((s) => {
    const { receivedOn = null, lastChasedOn = null } = days[s.id] ?? {};
    const chaseNumber = Math.max(0, s.reviewChaseCount) + 1;
    const offset = chaseOffset(ladder, chaseNumber);
    const dueOn = receivedOn ? addDays(receivedOn, offset) : null;

    /* The engine's own answer to "is this ask owed today". Null covers a
       future rung, an ask already made today, and a sample with no received
       date to count from — three different reasons a row is quiet, and the
       screen draws each of them differently. */
    const due = sampleChaseDue(
      {
        id: s.id,
        state: s.state,
        receivedOn,
        chaseCount: s.reviewChaseCount,
        lastChasedOn,
      },
      day,
      ladder,
    );

    return {
      id: s.id,
      customerId: s.customerId,
      customerName: s.customerName,
      city: s.city,
      salesmanName: s.salesmanName,
      productName: s.productName,
      quantityCans: s.quantityCans,
      state: s.state,
      reviewChaseCount: s.reviewChaseCount,
      lastReviewChaseAt: s.lastReviewChaseAt,
      receivedAt: s.receivedAt,
      receivedOn,
      waitingDays: s.waitingDays,
      chaseNumber,
      dueOn,
      /* Past its day and nobody has asked. The number a manager acts on. */
      overdueDays: dueOn && dueOn < day ? daysBetween(dueOn, day) : 0,
      dueNow: due !== null,
      dueDetail: due?.detail ?? null,
      askedToday: lastChasedOn !== null && lastChasedOn >= day,
      /* Past the end of the ladder: every rung from here is the repeat. */
      pastTheLadder: chaseNumber > ladder.length,
    };
  });

  /* Most-chased first is `samplesAwaitingReview`'s own order and it is the
     right one — the sample asked about five times is closest to being written
     off. The overdue days break the tie inside a chase count, so among four
     leads all asked twice the one that has been ignored longest is first. */
  rows.sort(
    (a, b) =>
      b.reviewChaseCount - a.reviewChaseCount ||
      b.overdueDays - a.overdueDays ||
      (a.receivedOn ?? "").localeCompare(b.receivedOn ?? "") ||
      a.id.localeCompare(b.id),
  );

  return <ChasesScreen workspace={workspace} rows={rows} ladder={[...ladder]} today={day} />;
}

