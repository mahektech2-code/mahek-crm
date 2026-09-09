"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { shortDate, stamp } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import {
  FEEDBACK_FIELDS,
  SAMPLE_REASONS,
  labelOf,
  sampleStateLabel,
  type SampleState,
} from "@/lib/lead-labels";
import type { SampleDeskRow } from "@/lib/services/lead-console-service";
import {
  confirmSampleReceived,
  decideSample,
  dispatchSample,
  recordSampleFeedback,
} from "@/lib/actions/lead-samples";
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
} from "../../parts";
import { plural } from "../../words";

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
  rows,
  chaseDays,
}: {
  rows: SampleDeskRow[];
  /** The ladder the review chase climbs — 2, then 4, then 6. */
  chaseDays: number[];
}) {
  const router = useRouter();
  const toast = useToast();

  const [acting, setActing] = React.useState<Acting | null>(null);
  const [note, setNote] = React.useState("");
  const [courier, setCourier] = React.useState("");
  const [docket, setDocket] = React.useState("");
  const [expected, setExpected] = React.useState("");
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [outcome, setOutcome] = React.useState<"approved" | "rejected">("approved");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(next: Acting) {
    setActing(next);
    setNote("");
    setCourier(next.kind === "dispatch" ? (next.row.courierName ?? "") : "");
    setDocket(next.kind === "dispatch" ? (next.row.trackingNumber ?? "") : "");
    setExpected(next.kind === "dispatch" ? (next.row.expectedDeliveryDate ?? "") : "");
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
                  trialOutcome: outcome,
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

  const awaitingApproval = rows.filter((r) => r.approvalState === "pending");
  const late = rows.filter((r) => r.lateByDays != null);
  const awaitingReview = rows.filter(
    (r) => !r.feedbackRecorded && (r.state === "received" || r.state === "trial_done"),
  );
  const chasedHard = rows.filter((r) => r.reviewChaseCount >= chaseDays.length);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Sample desk"
        subtitle="Approve it, send it, watch it land, and write down what they thought. A sample with no feedback is stock given away — and one nobody has answered is a salesman who cannot move."
        actions={
          <Link
            href="/sales/samples"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← Samples
          </Link>
        }
      />

      {chasedHard.length ? (
        <Banner
          tone="warn"
          title={`${plural(chasedHard.length, "trial")} chased ${plural(chaseDays.length, "time")} with no answer`}
          body="The ladder has run out. Nothing further will be raised automatically — these are the ones to ring yourself."
        />
      ) : null}

      {late.length ? (
        <Banner
          tone="danger"
          title={`${plural(late.length, "sample")} past the promised delivery date`}
          body="A docket with no movement on it is a sample nobody will ever review. The courier promised a day and it has gone."
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "Waiting on approval",
            value: String(awaitingApproval.length),
            tone: awaitingApproval.length ? "warn" : undefined,
          },
          {
            label: "Late in delivery",
            value: String(late.length),
            tone: late.length ? "danger" : undefined,
          },
          { label: "Delivered, not reviewed", value: String(awaitingReview.length) },
          { label: "On the desk", value: String(rows.length) },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nothing on the desk"
          body="A sample reaches here when a salesman asks for one on a visit. Nothing goes out without somebody approving it, which is why the desk is the first stop rather than the courier."
        />
      ) : (
        <Table
          minWidth={1420}
          head={
            <>
              <HeadCell width={210}>Customer</HeadCell>
              <HeadCell width={210}>What, and why</HeadCell>
              <HeadCell width={150}>State</HeadCell>
              <HeadCell width={200}>Dispatch</HeadCell>
              <HeadCell width={170}>Delivery</HeadCell>
              <HeadCell width={210}>Review</HeadCell>
              <HeadCell align="right" width={250} />
            </>
          }
        >
          {rows.map((r, i) => (
            <Row key={r.id} striped={i % 2 === 1}>
              <Cell truncate={210}>
                <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
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
                  {labelOf(SAMPLE_REASONS, r.reasonCode)}
                  {r.application ? ` · for ${r.application}` : ""}
                </span>
              </Cell>
              <Cell>
                <Pill
                  tone={
                    r.state === "reviewed"
                      ? "success"
                      : r.state === "rejected"
                        ? "danger"
                        : r.approvalState === "pending"
                          ? "warn"
                          : "brand"
                  }
                >
                  {sampleStateLabel(r.state as SampleState)}
                </Pill>
                {r.approvalState === "pending" ? (
                  <span className="block text-[12px] text-warn-ink">not approved yet</span>
                ) : null}
                {r.requestedDate ? (
                  <span className="block text-[12px] text-muted">
                    asked {shortDate(r.requestedDate)}
                  </span>
                ) : null}
              </Cell>
              <Cell truncate={200}>
                {r.dispatchedAt ? (
                  <>
                    <span className="block truncate text-[13px] text-body">
                      {r.courierName ?? "courier not named"}
                    </span>
                    <span className="block truncate text-[12px] text-muted">
                      {r.trackingNumber ?? "no docket"} · {stamp(r.dispatchedAt)}
                    </span>
                  </>
                ) : (
                  <span className="text-muted">Not sent</span>
                )}
              </Cell>
              <Cell truncate={170}>
                {r.receivedAt ? (
                  <>
                    <Pill tone="success">Landed</Pill>
                    <span className="block text-[12px] text-muted">
                      {stamp(r.receivedAt)}
                    </span>
                  </>
                ) : r.expectedDeliveryDate ? (
                  <>
                    <span className="block text-[13px] text-body">
                      promised {shortDate(r.expectedDeliveryDate)}
                    </span>
                    {r.lateByDays != null ? (
                      <span className="block text-[12px] text-danger">
                        {plural(r.lateByDays, "day")} past it
                      </span>
                    ) : (
                      <span className="block text-[12px] text-muted">not confirmed</span>
                    )}
                  </>
                ) : (
                  <span className="text-muted">Nothing promised</span>
                )}
              </Cell>
              <Cell truncate={210}>
                {r.feedbackRecorded ? (
                  <>
                    <Pill tone="success">Reviewed</Pill>
                    <span className="block truncate text-[12px] text-muted">
                      {[r.feedbackQuality, r.feedbackPerformance, r.feedbackPrice]
                        .filter(Boolean)
                        .join(" · ") || "recorded"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="block text-[13px] text-body">Nothing recorded</span>
                    <span
                      className="block text-[12px] text-muted"
                      title={
                        r.lastReviewChaseAt
                          ? `Last chased ${stamp(r.lastReviewChaseAt)}`
                          : undefined
                      }
                    >
                      {r.reviewChaseCount
                        ? `asked ${plural(r.reviewChaseCount, "time")}`
                        : "not chased"}
                    </span>
                  </>
                )}
              </Cell>
              <Cell align="right">
                <span className="flex justify-end gap-1.5">
                  {r.approvalState === "pending" ? (
                    <>
                      <Button
                        size="sm"
                        tone="primary"
                        onClick={() => begin({ kind: "decide", row: r, approve: true })}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        tone="danger"
                        onClick={() => begin({ kind: "decide", row: r, approve: false })}
                      >
                        Refuse
                      </Button>
                    </>
                  ) : !r.dispatchedAt ? (
                    <Button size="sm" onClick={() => begin({ kind: "dispatch", row: r })}>
                      Record dispatch
                    </Button>
                  ) : !r.receivedAt ? (
                    <Button size="sm" onClick={() => begin({ kind: "received", row: r })}>
                      Confirm received
                    </Button>
                  ) : !r.feedbackRecorded ? (
                    <Button
                      size="sm"
                      tone="primary"
                      onClick={() => begin({ kind: "feedback", row: r })}
                    >
                      Record feedback
                    </Button>
                  ) : (
                    <span className="text-[12px] text-muted">Nothing outstanding</span>
                  )}
                </span>
              </Cell>
            </Row>
          ))}
        </Table>
      )}

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
            <div className="grid grid-cols-2 gap-4">
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
              <span className="mt-1 block text-[12px] text-muted">
                What the courier said. Without it nothing on any screen can tell a sample in
                transit from one that has gone missing.
              </span>
            </label>
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <Footer
              busy={busy}
              disabled={!expected || !courier.trim()}
              title={
                !courier.trim()
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
        title="Confirm it was received"
        width={440}
      >
        {acting?.kind === "received" ? (
          <>
            <Subject row={acting.row} />
            <p className="text-[13px] text-body">
              Confirmed by the customer or the salesman, not by the courier. A tracking status is
              the courier&rsquo;s word about their own performance; this is somebody saying the
              cans are on the shelf.
            </p>
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <Footer
              busy={busy}
              disabled={false}
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
        width={680}
      >
        {acting?.kind === "feedback" ? (
          <>
            <Subject row={acting.row} />
            <div className="grid max-h-[42vh] grid-cols-2 gap-x-4 gap-y-2.5 overflow-y-auto pr-1">
              {FEEDBACK_FIELDS.map((f) => (
                <label key={f.id} className="block">
                  <span className="mb-1 block text-[13px] text-body">{f.label}</span>
                  <input
                    value={fields[f.id] ?? ""}
                    onChange={(e) =>
                      setFields((prev) => ({ ...prev, [f.id]: e.target.value }))
                    }
                    className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                  />
                </label>
              ))}
            </div>

            <div className="mt-4 border-t border-divider pt-3">
              <span className="mb-1 block text-[13px] font-medium text-ink">The verdict</span>
              <div className="flex gap-2">
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
              </div>
              <p className="mt-1.5 text-[12px] text-muted">
                Negotiation does not open until the trial is approved — and a rejected trial with
                the seven answers behind it is worth far more than a lead quietly going cold.
              </p>
            </div>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <Footer
              busy={busy}
              disabled={!Object.values(fields).some((v) => v.trim())}
              title={
                Object.values(fields).some((v) => v.trim())
                  ? undefined
                  : "Answer at least one of them. A verdict with nothing behind it is the notes field this replaced."
              }
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
