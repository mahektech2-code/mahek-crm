"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { shortDate, stamp } from "@/lib/format";
import { FEEDBACK_FIELDS, sampleStateLabel, type SampleState } from "@/lib/lead-labels";
import { recordSampleFeedback } from "@/lib/actions/lead-samples";
import { LeadTabs } from "../../leads/lead-tabs";
import {
  Banner,
  Button,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "@/components/console/parts";
import { plural } from "@/components/console/words";

/**
 * One sample in the chase loop, with the rung it is on.
 *
 * Everything here is either read off `mbos_samples` or computed by the two
 * nurture-engine functions on the server. Nothing is estimated and nothing is
 * filled in: `dueOn` is null where a sample carries no received date, and that
 * is drawn as the gap it is rather than as a date somebody could act on.
 */
export type ChaseRow = {
  id: string;
  customerId: string;
  customerName: string;
  city: string | null;
  salesmanName: string | null;
  productName: string | null;
  quantityCans: number | null;
  state: SampleState;
  /** §16's own counter, stored on the sample. The number a manager acts on. */
  reviewChaseCount: number;
  lastReviewChaseAt: string | null;
  receivedAt: string | null;
  receivedOn: string | null;
  waitingDays: number;
  /** 1-based. The next ask, not the last one. */
  chaseNumber: number;
  dueOn: string | null;
  overdueDays: number;
  /** `sampleChaseDue` said yes for today. */
  dueNow: boolean;
  dueDetail: string | null;
  askedToday: boolean;
  /** Past the configured ladder — every rung from here is the repeat. */
  pastTheLadder: boolean;
};

type Acting = { row: ChaseRow };

/**
 * Review chases — §16, which does not stop.
 *
 * **The chase count is the subject of this screen, not a column on it.** Every
 * other sample list is sorted by a date; this one is sorted by how many times
 * we have asked, because the ladder repeating for ever means a date tells you
 * only that today is another day and the count tells you the conversation has
 * failed five times. Past the end of the configured ladder the row says so in
 * words — nothing new is being raised, the last interval is simply repeating,
 * and somebody senior ringing the shop is the only thing that ends it.
 *
 * **Closing the loop is the only write, and it is the desk's own action.**
 * `recordSampleFeedback` takes §16's seven answers and the verdict, and there
 * is no "mark as chased" button anywhere here: the chase count is moved by the
 * nightly pass that raises the task, and a screen that let somebody increment
 * it by hand would let the ladder be walked to the top without a single call
 * being made.
 *
 * **`more_testing` is offered as a real third answer.** "They want to try it
 * again on a different substrate" is neither approval nor rejection, and
 * filing it as pending loses the fact that a trial happened at all — which on
 * this screen would mean the sample stays in the loop being chased for an
 * answer it has already given.
 */
export function ChasesScreen({
  workspace,
  rows,
  ladder,
  today,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  rows: ChaseRow[];
  /** `leads.sampleReviewChaseDays` — day 2, then 4, then 6, then the repeat. */
  ladder: number[];
  /** The business's own day, read on the server. */
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [acting, setActing] = React.useState<Acting | null>(null);
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [outcome, setOutcome] = React.useState<"approved" | "rejected" | "more_testing">(
    "approved",
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(row: ChaseRow) {
    setActing({ row });
    setFields({});
    setOutcome("approved");
    setError(null);
  }

  async function submit() {
    if (!acting) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await recordSampleFeedback(acting.row.id, { fields, trialOutcome: outcome });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setActing(null);
    toast.push(result.message ?? "Recorded. The chasing stops here.");
    router.refresh();
  }

  const dueToday = rows.filter((r) => r.dueNow);
  const pastTheLadder = rows.filter((r) => r.pastTheLadder);
  const neverAsked = rows.filter((r) => r.reviewChaseCount === 0);
  const noReceivedDate = rows.filter((r) => r.receivedOn === null);
  const mostAsked = rows.reduce((n, r) => Math.max(n, r.reviewChaseCount), 0);

  /* The ladder said in the words a manager would use, out of configuration
     rather than out of a sentence typed here — a team that changed 2·4·6 to
     3·7·14 must not read a screen still quoting the default at them. */
  const ladderWords = ladder.length
    ? `day ${ladder.join(", then ")}, and then every ${plural(
        ladder.length >= 2 ? Math.max(1, ladder[ladder.length - 1]! - ladder[ladder.length - 2]!) : ladder[0]!,
        "day",
      )}`
    : "every day — no ladder is configured, so the chase falls daily";

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} counts={{ [leadHref(workspace, "samples/chases")]: dueToday.length }} />

      <ScreenHeader
        title="Review chases"
        subtitle={`§16 does not stop. A sample review is asked for on ${ladderWords}, until there is an answer — because a trial nobody reviewed is stock given away for nothing. "Asked three times" is the number that tells you to ring the shop yourself.`}
        actions={
          <Link
            href={leadHref(workspace, "samples/desk")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Sample desk →
          </Link>
        }
      />

      {pastTheLadder.length ? (
        <Banner
          tone="warn"
          title={`${plural(pastTheLadder.length, "trial")} past the end of the ladder`}
          body={`Asked ${plural(ladder.length, "time")} on the configured rungs with no answer. Nothing new is being scheduled — the last interval is simply repeating, and it will go on repeating. These are the ones to ring yourself, or to cancel and say why.`}
        />
      ) : null}

      {noReceivedDate.length ? (
        <Banner
          tone="danger"
          title={`${plural(noReceivedDate.length, "sample")} with no confirmed receipt date`}
          body="The ladder counts from the day the SHOP said it arrived, and these carry no such day — so no chase can be dated and none will ever fall. Confirm the receipt on the sample desk and the loop starts."
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "Due to be asked today",
            value: String(dueToday.length),
            tone: dueToday.length ? "warn" : undefined,
          },
          {
            label: "Most times asked",
            value: String(mostAsked),
            sub: mostAsked ? "one trial" : undefined,
            tone: mostAsked > ladder.length ? "danger" : undefined,
          },
          {
            label: "Never asked yet",
            value: String(neverAsked.length),
            sub: "delivered, first ask still to fall",
          },
          { label: "In the loop", value: String(rows.length) },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="No trial is waiting on an answer"
          body="A sample enters this loop when the customer confirms it arrived, and leaves it when somebody writes down what they thought. Nothing is in between today."
        />
      ) : (
        <Table
          minWidth={1320}
          head={
            <>
              <HeadCell width={230}>Customer</HeadCell>
              <HeadCell width={210}>What is out there</HeadCell>
              <HeadCell width={150}>Asked</HeadCell>
              <HeadCell width={190}>Next ask</HeadCell>
              <HeadCell width={180}>Received</HeadCell>
              <HeadCell width={130}>State</HeadCell>
              <HeadCell align="right" width={200} />
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell truncate={230}>
                <Link href={leadHref(workspace, `leads/${r.customerId}`)} className="no-underline">
                  {r.customerName}
                </Link>
                <span className="block truncate text-[12px] text-muted">
                  {[r.city, r.salesmanName].filter(Boolean).join(" · ") || "—"}
                </span>
              </Cell>

              <Cell truncate={210}>
                <span className="block truncate text-[13px] text-body">
                  {r.quantityCans ? `${plural(r.quantityCans, "can")} · ` : ""}
                  {r.productName ?? "no product named"}
                </span>
                <span className="block truncate text-[12px] text-muted">
                  {plural(r.waitingDays, "day")} since it landed
                </span>
              </Cell>

              {/* The whole point of the screen. A count, said as a count. */}
              <Cell
                title={
                  r.lastReviewChaseAt
                    ? `Last asked ${stamp(r.lastReviewChaseAt)}`
                    : "Nobody has asked yet."
                }
              >
                {r.reviewChaseCount === 0 ? (
                  <span className="text-[13px] text-muted">Not yet asked</span>
                ) : (
                  <>
                    <span
                      className={
                        r.pastTheLadder
                          ? "text-[15px] font-semibold text-danger tabular-nums"
                          : "text-[15px] font-semibold text-ink tabular-nums"
                      }
                    >
                      {plural(r.reviewChaseCount, "time")}
                    </span>
                    <span className="block text-[12px] text-muted">
                      {r.lastReviewChaseAt
                        ? `last ${shortDate(r.lastReviewChaseAt)}`
                        : "date not recorded"}
                    </span>
                  </>
                )}
              </Cell>

              <Cell truncate={190}>
                {r.dueOn === null ? (
                  <span className="text-[13px] text-danger">
                    Nothing to count from
                    <span className="block text-[12px] text-muted">
                      no confirmed receipt date
                    </span>
                  </span>
                ) : r.askedToday ? (
                  <>
                    <Pill tone="success">Asked today</Pill>
                    <span className="block text-[12px] text-muted">
                      next ask {shortDate(r.dueOn)}
                    </span>
                  </>
                ) : r.dueNow ? (
                  <>
                    <Pill tone="warn">Ask {ordinal(r.chaseNumber)}</Pill>
                    <span className="block text-[12px] text-warn-ink">
                      {r.overdueDays > 0
                        ? `due ${shortDate(r.dueOn)} — ${plural(r.overdueDays, "day")} ago`
                        : `due today`}
                    </span>
                    {/* The engine's own sentence, not a second copy of it. */}
                    {r.dueDetail ? (
                      <span className="block text-[12px] text-muted">{r.dueDetail}</span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="block text-[13px] text-body">
                      {ordinal(r.chaseNumber)} ask {shortDate(r.dueOn)}
                    </span>
                    <span className="block text-[12px] text-muted">not due yet</span>
                  </>
                )}
                {r.pastTheLadder && r.dueOn ? (
                  <span className="block text-[12px] text-danger">
                    the ladder is repeating
                  </span>
                ) : null}
              </Cell>

              <Cell truncate={180}>
                {r.receivedAt ? (
                  <>
                    <span className="block text-[13px] text-body">
                      {shortDate(r.receivedAt)}
                    </span>
                    <span
                      className="block text-[12px] text-muted"
                      title="The shop's own word that it is in their hands — never our dispatch date, and never the carrier's."
                    >
                      the shop confirmed it
                    </span>
                  </>
                ) : (
                  <span className="text-muted">Not confirmed</span>
                )}
              </Cell>

              <Cell>
                <Pill tone={r.state === "trial_done" ? "brand" : "neutral"}>
                  {sampleStateLabel(r.state)}
                </Pill>
                {r.state === "trial_done" ? (
                  <span className="block text-[12px] text-muted">tried, not reviewed</span>
                ) : null}
              </Cell>

              <Cell align="right">
                <span className="flex justify-end gap-1.5">
                  <Button size="sm" tone="primary" onClick={() => begin(r)}>
                    Record the answer
                  </Button>
                </span>
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      <p className="mt-4 max-w-[760px] text-[12px] leading-[17px] text-muted">
        Nothing on this screen moves the chase count. It is written by the nightly
        pass that raises the task, so the number always says how many times somebody
        was actually asked to make the call — a button that let it be ticked along by
        hand would let the ladder be walked to the top with no call ever made. What
        ends the loop is an answer, or cancelling the sample and saying why. Every
        date on this screen is measured against {shortDate(today)}, the business
        day rather than the browser&rsquo;s.
      </p>

      {/* ------------------------------------------------ §16's seven answers */}
      <Modal
        open={acting !== null}
        onClose={() => setActing(null)}
        title="What did they think?"
        width={680}
      >
        {acting ? (
          <>
            <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
              <div className="font-medium text-ink">{acting.row.customerName}</div>
              <div className="text-muted">
                {acting.row.quantityCans ? `${plural(acting.row.quantityCans, "can")} of ` : ""}
                {acting.row.productName ?? "a product nobody named"}
                {acting.row.salesmanName ? ` · ${acting.row.salesmanName}` : ""}
              </div>
              {acting.row.reviewChaseCount ? (
                <div className="mt-1 text-[12px] text-warn-ink">
                  Asked {plural(acting.row.reviewChaseCount, "time")} already
                  {acting.row.pastTheLadder ? ", and the ladder has run out" : ""}.
                </div>
              ) : null}
            </div>

            <p className="mb-3 text-[13px] text-body">
              Seven answers rather than one box. The whole point of a trial is the
              comparison, and &ldquo;good&rdquo; cannot be read back six weeks later as
              &ldquo;better drying than what they use, price is the problem&rdquo;.
            </p>

            <div className="grid max-h-[40vh] grid-cols-2 gap-x-4 gap-y-2.5 overflow-y-auto pr-1">
              {FEEDBACK_FIELDS.map((f) => (
                <label key={f.id} className="block">
                  <span className="mb-1 block text-[13px] text-body">{f.label}</span>
                  <input
                    value={fields[f.id] ?? ""}
                    onChange={(e) => setFields((prev) => ({ ...prev, [f.id]: e.target.value }))}
                    className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                  />
                </label>
              ))}
            </div>

            <div className="mt-4 border-t border-divider pt-3">
              <span className="mb-1 block text-[13px] font-medium text-ink">The verdict</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  tone={outcome === "approved" ? "primary" : "default"}
                  onClick={() => setOutcome("approved")}
                >
                  They liked it
                </Button>
                <Button
                  size="sm"
                  tone={outcome === "rejected" ? "danger" : "default"}
                  onClick={() => setOutcome("rejected")}
                >
                  They did not
                </Button>
                <Button
                  size="sm"
                  tone={outcome === "more_testing" ? "primary" : "default"}
                  onClick={() => setOutcome("more_testing")}
                >
                  They want to test it further
                </Button>
              </div>
              <p className="mt-1.5 text-[12px] text-muted">
                {outcome === "more_testing"
                  ? "A real third answer, not a shrug — a trial on a different substrate happened and produced an opinion, and filing that as pending would lose the fact of it."
                  : outcome === "rejected"
                    ? "A refusal with the seven answers behind it is worth far more than a lead quietly going cold. The reason is kept on the sample."
                    : "Negotiation opens on an approved trial — that is what authorises the commercial conversation, rather than the salesman deciding he is ready for one."}
              </p>
            </div>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={busy || !Object.values(fields).some((v) => v.trim())}
                title={
                  Object.values(fields).some((v) => v.trim())
                    ? undefined
                    : "Answer at least one of them. A verdict with nothing behind it is the notes field this replaced."
                }
                onClick={() => void submit()}
              >
                {busy ? "Saving…" : "Record the review"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

/** "3rd ask" reads as a rung; "ask 3" reads as a batch number. */
function ordinal(n: number): string {
  const rest = n % 100;
  const last = n % 10;
  const suffix =
    rest >= 11 && rest <= 13 ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}
