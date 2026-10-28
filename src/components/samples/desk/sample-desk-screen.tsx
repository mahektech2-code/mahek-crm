"use client";

import { OutsideLeadHub } from "@/components/leads/hub/hub-context";
import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { shortDate, stamp } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  ACTIVE_FEEDBACK_FIELDS,
  trialReviewProblem,
  SAMPLE_REASONS,
  labelOf,
  stageLabel,
  type LeadStage,
} from "@/lib/lead-labels";
import type { SampleDeskRow } from "@/lib/services/lead-console-service";
import { qualifiedForSample } from "@/lib/engines/lead-ladder";
import {
  confirmSampleReceived,
  decideSample,
  dispatchSample,
  recordSampleFeedback,
} from "@/lib/actions/lead-samples";
import { Button, RowMenu, ScreenHeader } from "@/components/console/parts";
import { plural } from "@/components/console/words";
import { CancelForm } from "@/components/samples/cancel-sample";

type Acting =
  | { kind: "decide"; row: SampleDeskRow; approve: boolean }
  | { kind: "dispatch"; row: SampleDeskRow }
  | { kind: "received"; row: SampleDeskRow }
  | { kind: "feedback"; row: SampleDeskRow };

/**
 * The sample desk.
 *
 * **The chase count is a column, not a summary.** "Asked three times" is the
 * number that tells a manager to stop raising tasks and ring the shop
 * themselves, and it is invisible in any figure that only counts what is
 * outstanding. It is stored on the sample rather than counted from tasks,
 * because the ladder — day 2, then 4, then 6 — has to know which rung it is on
 * without a query.
 *
 * **Delivery is watched against what was PROMISED.** `expected_delivery_date`
 * is the courier's word and `received_at` is what actually happened,
 * confirmed by the customer or the salesman rather than by the courier. A
 * docket with no movement on it is a sample nobody will ever review, and the
 * row says so on the day it goes past rather than at the review call a
 * fortnight later.
 *
 * **The seven feedback fields, never one box.** The whole point of a trial is
 * the comparison, and "good" written in a notes field cannot be read back as
 * "better drying than the competitor, price is the problem".
 */
export function SampleDeskScreen({
  workspace,
  rows,
  chaseDays,
  cancelReasons,
  canWork,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  rows: SampleDeskRow[];
  /** The ladder the review chase climbs — 2, then 4, then 6. */
  chaseDays: number[];
  /**
   * `leads.sampleCancelReasons`, resolved on the server and passed down.
   *
   * A "use client" component cannot read configuration, and building the
   * picker from the literal instead would offer a code the action refuses
   * wherever Mahek has reworded the list — a refusal that reads as the app
   * being broken rather than as the list having moved.
   */
  cancelReasons: { code: string; label: string }[];
  /**
   * `lead.work`, resolved on the server and passed down.
   *
   * It gates the CANCEL control alone, which is the only one this screen draws
   * that was not here before. The four beside it — approve, dispatch, confirm,
   * review — are left exactly as they shipped: adding a gate to a control
   * people have been using would be a different change with a different
   * argument, and one somebody should make deliberately rather than as a side
   * effect of wiring up a fifth button.
   */
  canWork: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [acting, setActing] = React.useState<Acting | null>(null);
  const [note, setNote] = React.useState("");
  const [courier, setCourier] = React.useState("");
  const [docket, setDocket] = React.useState("");
  const [expected, setExpected] = React.useState("");
  const [fields, setFields] = React.useState<Record<string, string>>({});
  /*
   * THREE VERDICTS, because "more testing" is a real answer and not a shrug.
   *
   * The desk offered two. The enum, `recordSampleFeedback`'s own schema and the
   * record screen all carry a third — and "they want to try it again on a
   * different substrate" is neither approval nor rejection. Recorded as
   * pending it loses the fact that a trial happened at all; recorded as
   * rejected it writes off a live opportunity. Either way the §16 chase stops
   * counting, which is the part that costs something.
   */
  /* No default: a verdict is mandatory, and one nobody chose is not one. */
  const [outcome, setOutcome] = React.useState<"approved" | "rejected" | "more_testing" | null>(
    null,
  );
  /* STEP 2 of Sample / Trial opens with "Has the sample been received?". */
  const [receivedAnswer, setReceivedAnswer] = React.useState<"yes" | "no" | null>(null);
  const [cancelling, setCancelling] = React.useState<SampleDeskRow | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(next: Acting) {
    setActing(next);
    setNote("");
    setCourier(next.kind === "dispatch" ? (next.row.courierName ?? "") : "");
    setDocket(next.kind === "dispatch" ? (next.row.trackingNumber ?? "") : "");
    setExpected(next.kind === "dispatch" ? (next.row.expectedDeliveryDate ?? "") : "");
    setFields({});
    setOutcome(null);
    setReceivedAnswer(null);
    setError(null);
  }

  async function submit() {
    if (!acting) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result =
        acting.kind === "decide"
          ? await decideSample(acting.row.id, {
              approve: acting.approve,
              note: note.trim() || undefined,
            })
          : acting.kind === "dispatch"
            ? await dispatchSample(acting.row.id, {
                courierName: courier.trim(),
                trackingNumber: docket.trim(),
                expectedDeliveryDate: expected,
              })
            : acting.kind === "received"
              ? await confirmSampleReceived(acting.row.id, {})
              : await recordSampleFeedback(acting.row.id, {
                  fields,
                  trialOutcome: outcome!,
                });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setActing(null);
    toast.push(result.message ?? "Recorded.");
    router.refresh();
  }

  /*
   * ANSWER 01 — WAITING ON A MANAGER, AND A HANDSET REQUEST IS ONE OF THOSE.
   *
   * This read the approval row alone, which is right for anything raised from
   * a desk — `requestSample` writes the sample and its `mbos_approvals` row in
   * one transaction, so the two cannot disagree. It is NOT right for a sample
   * the handset sent: `handleSample` inserts the sample at `requested` and
   * writes no approval row, because an APK in somebody's pocket knows nothing
   * about the approval step and cannot be made to. So those rows had a null
   * approval state, fell straight past this filter and past the Approve /
   * Refuse buttons below, and offered "Record dispatch" instead — a salesman's
   * ask going out of the godown with nobody having said yes, which is the one
   * thing the approval step exists to stop.
   *
   * The sample's own `requested` is the honest second reading of the same
   * fact, and `decideSample` writes the missing approval row when it lands, so
   * answering it here costs nothing and loses nothing.
   */
  const pendingApproval = (r: SampleDeskRow) =>
    r.approvalState === "pending" || r.state === "requested";
  const late = rows.filter((r) => r.lateByDays != null);
  const chasedHard = rows.filter((r) => r.reviewChaseCount >= chaseDays.length);

  /* One lane per thing a sample is waiting for, in the order it waits for
     them. Every row lands in exactly one lane; a refused request, or a state
     nobody taught this screen, falls to the last one with nothing to press. */
  const laneOf = (r: SampleDeskRow): LaneKey =>
    pendingApproval(r)
      ? "approve"
      : r.state === "rejected"
        ? "done"
        : r.state === "approved" && !r.dispatchedAt
          ? "dispatch"
          : r.dispatchedAt && !r.receivedAt
            ? "transit"
            : r.receivedAt && !r.feedbackRecorded
              ? "review"
              : "done";
  const lanes = LANES.map((l) => ({ ...l, rows: rows.filter((r) => laneOf(r) === l.key) }));

  return (
    <div className="p-6">
      <ScreenHeader
        title="Sample desk"
        actions={
          <>
            {chasedHard.length ? (
              <span
                className="inline-flex h-6 items-center rounded-full bg-warn-soft px-2.5 text-xs font-medium text-warn-ink"
                title={`Chased ${plural(chaseDays.length, "time")} with no answer — nothing more will be raised automatically.`}
              >
                {plural(chasedHard.length, "trial")} out of chases
              </span>
            ) : null}
            {late.length ? (
              <span className="inline-flex h-6 items-center rounded-full bg-danger-soft px-2.5 text-xs font-medium text-danger">
                {late.length} past promised delivery
              </span>
            ) : null}
            <OutsideLeadHub>
              <Link
                href={leadHref(workspace, "samples")}
                className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
              >
                ← Samples
              </Link>
            </OutsideLeadHub>
          </>
        }
      />

      <div className="overflow-x-auto pb-1.5">
        <div className="grid min-w-[1060px] grid-cols-[repeat(5,minmax(200px,1fr))] items-start gap-3">
          {lanes.map((lane) => {
            const shown = lane.key === "done" ? lane.rows.slice(0, DONE_SHOWN) : lane.rows;
            return (
              <section
                key={lane.key}
                aria-label={lane.label}
                className="flex flex-col gap-2 rounded-[10px] bg-divider p-2.5"
              >
                <div className="flex items-center gap-2 px-1 pt-0.5 pb-1">
                  <h2 className="m-0 flex-1 text-[13px] font-semibold text-ink">{lane.label}</h2>
                  <span className="h-[18px] min-w-5 rounded-[9px] bg-surface px-1.5 text-center text-[11px] leading-[18px] font-semibold text-body tabular-nums">
                    {lane.rows.length}
                  </span>
                </div>
                {shown.map((r) => (
                  <SampleCard
                    key={r.id}
                    workspace={workspace}
                    row={r}
                    lane={lane.key}
                    chasedOut={r.reviewChaseCount >= chaseDays.length}
                    canWork={canWork}
                    onAct={begin}
                    onCancel={() => setCancelling(r)}
                  />
                ))}
                {lane.rows.length > shown.length ? (
                  <Link
                    href={leadHref(workspace, "samples")}
                    className="px-1 pt-0.5 text-xs"
                  >
                    + {lane.rows.length - shown.length} more
                  </Link>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>

      {cancelling ? (
        <CancelForm
          key={cancelling.id}
          sampleId={cancelling.id}
          what={`${cancelling.quantityCans ? `${plural(cancelling.quantityCans, "can")} of ` : ""}${cancelling.productName ?? "a product nobody named"} for ${cancelling.customerName}`}
          reasons={cancelReasons}
          onClose={() => setCancelling(null)}
        />
      ) : null}

      {/* ------------------------------------------------------------ decide */}
      <Modal
        open={acting?.kind === "decide"}
        onClose={() => setActing(null)}
        title={acting?.kind === "decide" && acting.approve ? "Approve the sample" : "Refuse it"}
        width={480}
      >
        {acting?.kind === "decide" ? (
          <>
            <Subject row={acting.row} />
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                {acting.approve ? "Anything to add (optional)" : "Why · required"}
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder={
                  acting.approve
                    ? "Goes to the salesman's handset with the answer"
                    : "He is often still standing in the shop"
                }
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <Footer
              busy={busy}
              disabled={!acting.approve && !note.trim()}
              title={
                !acting.approve && !note.trim()
                  ? "Say why — the salesman cannot work it out from the word alone."
                  : undefined
              }
              label={acting.approve ? "Approve" : "Refuse"}
              tone={acting.approve ? "primary" : "danger"}
              onCancel={() => setActing(null)}
              onConfirm={() => void submit()}
            />
          </>
        ) : null}
      </Modal>

      {/* ---------------------------------------------------------- dispatch */}
      <Modal
        open={acting?.kind === "dispatch"}
        onClose={() => setActing(null)}
        title="Record the dispatch"
        width={480}
      >
        {acting?.kind === "dispatch" ? (
          <>
            <Subject row={acting.row} />
            {acting.row.sendingMode === "hand_delivery" ? (
              <p className="mb-3 text-[13px] text-body">
                Hand delivery: there is no courier or docket to record, only the day it is due.
              </p>
            ) : null}
            <div className={`grid grid-cols-2 gap-4 ${acting.row.sendingMode === "hand_delivery" ? "hidden" : ""}`}>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">Courier</span>
                <input
                  value={courier}
                  onChange={(e) => setCourier(e.target.value)}
                  className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">Docket</span>
                <input
                  value={docket}
                  onChange={(e) => setDocket(e.target.value)}
                  className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
            </div>
            <label className="mt-3 block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                Promised delivery · required
              </span>
              <input
                type="date"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
              />
            </label>
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <Footer
              busy={busy}
              disabled={!expected || (acting.row.sendingMode !== "hand_delivery" && !courier.trim())}
              title={
                acting.row.sendingMode !== "hand_delivery" && !courier.trim()
                  ? "Name the courier — a docket with nobody to ring about it is a dead end."
                  : !expected
                    ? "Give the promised date. It is what the late flag is measured against."
                    : undefined
              }
              label="Record it"
              tone="primary"
              onCancel={() => setActing(null)}
              onConfirm={() => void submit()}
            />
          </>
        ) : null}
      </Modal>

      {/* ---------------------------------------------------------- received */}
      <Modal
        open={acting?.kind === "received"}
        onClose={() => setActing(null)}
        title="Sample received & review"
        width={440}
      >
        {acting?.kind === "received" ? (
          <>
            <Subject row={acting.row} />
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Sample received & review · Has the sample been received? · required
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                tone={receivedAnswer === "yes" ? "primary" : "default"}
                onClick={() => setReceivedAnswer("yes")}
              >
                Yes
              </Button>
              <Button
                size="sm"
                tone={receivedAnswer === "no" ? "primary" : "default"}
                onClick={() => setReceivedAnswer("no")}
              >
                No
              </Button>
            </div>
            {receivedAnswer === "no" ? (
              <p className="mt-2 text-[13px] text-body">
                The review stays locked. Nothing is marked received or reviewed, and the lead cannot go
                to Negotiation until the sample has arrived.
              </p>
            ) : null}
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <Footer
              busy={busy}
              disabled={receivedAnswer !== "yes"}
              title={receivedAnswer === "yes" ? undefined : "Answer Yes once the sample is actually in their hands."}
              label="They have it"
              tone="primary"
              onCancel={() => setActing(null)}
              onConfirm={() => void submit()}
            />
          </>
        ) : null}
      </Modal>

      {/* ---------------------------------------------------------- feedback */}
      <Modal
        open={acting?.kind === "feedback"}
        onClose={() => setActing(null)}
        title="What did they think?"
        width={560}
      >
        {acting?.kind === "feedback" ? (
          <>
            <Subject row={acting.row} />
            <div className="grid max-h-[42vh] grid-cols-1 gap-y-2.5 overflow-y-auto pr-1">
              {ACTIVE_FEEDBACK_FIELDS.map((f) => (
                <label key={f.id} className="block">
                  <span className="mb-1 block text-[13px] text-body">{f.label}</span>
                  <textarea
                    rows={2}
                    value={fields[f.id] ?? ""}
                    onChange={(e) =>
                      setFields((prev) => ({ ...prev, [f.id]: e.target.value }))
                    }
                    className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-brand"
                  />
                </label>
              ))}
            </div>

            <div className="mt-4 border-t border-divider pt-3">
              <span className="mb-1 block text-[13px] font-medium text-ink">Verdict · required</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  tone={outcome === "approved" ? "primary" : "default"}
                  onClick={() => setOutcome("approved")}
                >
                  Approved
                </Button>
                <Button
                  size="sm"
                  tone={outcome === "more_testing" ? "primary" : "default"}
                  onClick={() => setOutcome("more_testing")}
                  title="Neither yes nor no: they want to try it again. The lead stays where it is and the chase keeps counting."
                >
                  More Testing Required
                </Button>
                <Button
                  size="sm"
                  tone={outcome === "rejected" ? "danger" : "default"}
                  onClick={() => setOutcome("rejected")}
                >
                  Rejected
                </Button>
              </div>
            </div>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <Footer
              busy={busy}
              disabled={Boolean(trialReviewProblem(fields, outcome))}
              title={trialReviewProblem(fields, outcome) ?? undefined}
              label="Record the review"
              tone="primary"
              onCancel={() => setActing(null)}
              onConfirm={() => void submit()}
            />
          </>
        ) : null}
      </Modal>
    </div>
  );
}

function Subject({ row }: { row: SampleDeskRow }) {
  return (
    <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
      <div className="font-medium text-ink">{row.customerName}</div>
      <div className="text-muted">
        {row.quantityCans ? `${plural(row.quantityCans, "can")} of ` : ""}
        {row.productName ?? "a product nobody named"}
        {row.salesmanName ? ` · ${row.salesmanName}` : ""}
      </div>
      {row.reviewChaseCount ? (
        <div className="mt-1 text-[12px] text-warn-ink">
          Asked {plural(row.reviewChaseCount, "time")} already.
        </div>
      ) : null}
      {/*
       * ANSWER 05 — SAID TO THE PERSON DECIDING, which is the whole of the
       * exception.
       *
       * Approving a sample for a lead nobody has qualified is a different
       * decision from approving an ordinary one: there is no recorded monthly
       * requirement to weigh the cans against, no competitor the trial is meant
       * to beat and no potential value to justify the stock. The salesman is
       * allowed to ask — he may well be right that a can in the shopkeeper's
       * hand is what opens this one — but a manager who cannot see which of the
       * two he is answering is making neither decision.
       *
       * Read off `leadStageAtRequest`, the rung at the moment of asking, so a
       * lead that has moved since does not quietly erase the mark.
       */}
      {qualifiedForSample(row.leadStageAtRequest, row.salesType) ? null : (
        <div className="mt-1 text-[12px] text-warn-ink">
          Lead not qualified — this was asked for at{" "}
          {stageLabel(row.leadStageAtRequest as LeadStage)}.
        </div>
      )}
    </div>
  );
}

function Footer({
  busy,
  disabled,
  title,
  label,
  tone,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  disabled: boolean;
  title?: string;
  label: string;
  tone: "primary" | "danger";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <Button tone="quiet" onClick={onCancel}>
        Cancel
      </Button>
      <Button tone={tone} disabled={busy || disabled} title={title} onClick={onConfirm}>
        {busy ? "Saving…" : label}
      </Button>
    </div>
  );
}

type LaneKey = "approve" | "dispatch" | "transit" | "review" | "done";

const LANES: { key: LaneKey; label: string }[] = [
  { key: "approve", label: "To approve" },
  { key: "dispatch", label: "To dispatch" },
  { key: "transit", label: "On the way" },
  { key: "review", label: "Review due" },
  { key: "done", label: "Reviewed" },
];

/** The finished lane is history; the rest of it is on All samples. */
const DONE_SHOWN = 8;

const VERDICT: Record<string, string> = {
  approved: "Liked it",
  rejected: "Did not",
  more_testing: "Try again",
};

function SampleCard({
  workspace,
  row: r,
  lane,
  chasedOut,
  canWork,
  onAct,
  onCancel,
}: {
  workspace: LeadWorkspace;
  row: SampleDeskRow;
  lane: LaneKey;
  /** The review chase ladder has run out. */
  chasedOut: boolean;
  canWork: boolean;
  onAct: (next: Acting) => void;
  onCancel: () => void;
}) {
  const goods = `${r.quantityCans ? `${plural(r.quantityCans, "can")} · ` : ""}${r.productName ?? "No product named"}`;
  const why = [labelOf(SAMPLE_REASONS, r.reasonCode), r.application ? `for ${r.application}` : null]
    .filter(Boolean)
    .join(" · ");
  const asked = [r.requestedDate ? `Asked ${shortDate(r.requestedDate)}` : null, r.salesmanName]
    .filter(Boolean)
    .join(" · ");

  let what = goods;
  let note: string = asked;
  let late = false;
  let noteTitle: string | undefined;

  if (lane === "approve") {
    if (!qualifiedForSample(r.leadStageAtRequest, r.salesType)) note = `${note} · not qualified yet`;
  } else if (lane === "transit") {
    what = `${r.courierName ?? "Courier not named"} · ${r.trackingNumber ?? "no docket"}`;
    noteTitle = r.dispatchedAt ? `Sent ${stamp(r.dispatchedAt)}` : undefined;
    if (r.expectedDeliveryDate) {
      note = `Promised ${shortDate(r.expectedDeliveryDate)}`;
      if (r.lateByDays != null) {
        note += ` · ${plural(r.lateByDays, "day")} past`;
        late = true;
      }
    } else note = "Nothing promised";
  } else if (lane === "review") {
    what = `Landed ${shortDate(r.receivedAt)} · ${goods}`;
    note = r.reviewChaseCount ? `Asked ${r.reviewChaseCount}×` : "Not asked yet";
    noteTitle = r.lastReviewChaseAt ? `Last chased ${stamp(r.lastReviewChaseAt)}` : undefined;
    late = chasedOut;
  } else if (lane === "done") {
    if (r.state === "rejected") {
      /* A refused request is not dispatch work: nothing that follows a refusal
         ever fills a dispatch date in, so it would sit in that lane for ever. */
      what = goods;
      note = "Refused · nothing to send";
    } else if (r.feedbackRecorded) {
      what =
        [
          VERDICT[r.trialOutcome] ?? null,
          r.feedbackQuality,
          r.feedbackPerformance,
          r.feedbackPrice,
        ]
          .filter(Boolean)
          .join(" · ") || "Review recorded";
      note = [r.receivedAt ? `Landed ${shortDate(r.receivedAt)}` : null, r.salesmanName]
        .filter(Boolean)
        .join(" · ");
    } else note = "Nothing outstanding";
  }

  /* Cancel is leaving the journey, and it is open up to the review. `ALLOWED`
     in the action is the authority; this draws the same terminal states out. */
  const cancellable = !(r.state === "reviewed" || r.state === "rejected" || r.state === "cancelled");

  return (
    <article className="flex flex-col gap-1.5 rounded-[8px] border border-line bg-surface p-3">
      <div className="flex items-start gap-1.5">
        <Link
          href={leadHref(workspace, `samples/${r.id}`)}
          className="min-w-0 flex-1 font-semibold text-ink no-underline hover:underline"
        >
          {r.customerName}
        </Link>
        <RowMenu
          items={[
            { label: "Open the lead", href: leadHref(workspace, `leads/${r.customerId}`) },
            ...(cancellable
              ? [
                  {
                    label: "Cancel the sample",
                    danger: true,
                    disabled: !canWork,
                    title: canWork
                      ? "Withdraws the request, rejects any approval still waiting on it, and stops the review chase."
                      : "Calling a trial off is the salesman's and the manager's, the same hat that asks for one.",
                    run: onCancel,
                  },
                ]
              : []),
          ]}
        />
      </div>
      <span className="truncate text-[13px] text-body" title={why || undefined}>
        {what}
      </span>
      {note ? (
        <span className={cx("text-xs", late ? "text-danger" : "text-muted")} title={noteTitle}>
          {note}
        </span>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-1.5">
        {lane === "approve" ? (
          <>
            <Button size="sm" tone="primary" onClick={() => onAct({ kind: "decide", row: r, approve: true })}>
              Approve
            </Button>
            <Button size="sm" onClick={() => onAct({ kind: "decide", row: r, approve: false })}>
              Refuse
            </Button>
          </>
        ) : lane === "dispatch" ? (
          <Button size="sm" tone="primary" onClick={() => onAct({ kind: "dispatch", row: r })}>
            Record dispatch
          </Button>
        ) : lane === "transit" ? (
          <Button size="sm" tone="primary" onClick={() => onAct({ kind: "received", row: r })}>
            Confirm received
          </Button>
        ) : lane === "review" ? (
          <Button size="sm" tone="primary" onClick={() => onAct({ kind: "feedback", row: r })}>
            Record review
          </Button>
        ) : (
          <Link
            href={leadHref(workspace, `samples/${r.id}`)}
            className="inline-flex h-7 items-center rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Open
          </Link>
        )}
      </div>
    </article>
  );
}
