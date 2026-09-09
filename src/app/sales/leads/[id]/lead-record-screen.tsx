"use client";

import * as React from "react";
import Link from "next/link";
import { money, shortDate, stamp } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import {
  FEEDBACK_FIELDS,
  VERIFICATION_QUESTIONS,
  labelOf,
  LOST_REASONS,
  OVERRIDE_REASONS,
  PROSPECT_REASONS,
  SAMPLE_REASONS,
  salesTypeLabel,
  sampleStateLabel,
  stageLabel,
  stageSentence,
  type SampleState,
} from "@/lib/lead-labels";
import { checklistFor, type GateVerdict } from "@/lib/engines/lead-gates";
import { ladderFor } from "@/lib/engines/lead-ladder";
import type {
  HandoverCandidate,
  LeadOrderRow,
  LeadReceiptRow,
  LeadRecord,
  LeadTransition,
  ManagerCall,
  NurtureSchedule,
  PublishedDocument,
  TimelineRow,
} from "@/lib/services/lead-console-service";
import { Banner, Button, Cell, HeadCell, Pill, Row, ScreenHeader, Table } from "../../parts";
import { plural } from "../../words";
import { CommunicationPanel } from "../communication-panel";
import { FirstOrderPanel } from "../first-order-panel";
import { VerificationForm } from "../verification-form";
import { AdvanceStage } from "./advance-stage";
import { HandoverPanel } from "./handover-panel";

/**
 * One lead's whole record, in the order somebody reads it.
 *
 * Header — who they are and where they stand. Ladder — the whole climb with a
 * verdict on every rung, because a manager looking at a stalled lead wants to
 * see where it stopped and what it is waiting on, and being told one step at a
 * time is how a salesman learns the process by being refused. Then the answers,
 * the money, and the history.
 *
 * **It draws the ladder the engine gives it and never its own.** `ladderFor`
 * decides which rungs, `ladderVerdicts` decides what is open, and both ran on
 * the server. A screen that decided for itself which rungs a distributor
 * climbs would be a second copy inside a week.
 *
 * **Every disabled control says why.** A capability withheld and a gate shut
 * are different refusals, and the title says which — "you cannot do this" and
 * "this cannot be done yet" send somebody to two different places.
 */
export function LeadRecordScreen({
  record,
  verdicts,
  mustDecide,
  transitions,
  calls,
  timeline,
  timelineTotal,
  communications,
  orders,
  receipts,
  documents,
  nurture,
  handover,
  canVerify,
  canWork,
  canReassign,
  canOverride,
  overrideAllowed,
  nowMs,
}: {
  record: LeadRecord;
  verdicts: GateVerdict[];
  mustDecide: boolean;
  transitions: LeadTransition[];
  calls: ManagerCall[];
  timeline: TimelineRow[];
  timelineTotal: number;
  communications: TimelineRow[];
  orders: LeadOrderRow[];
  receipts: LeadReceiptRow[];
  documents: Record<string, PublishedDocument>;
  nurture: NurtureSchedule;
  handover: HandoverCandidate[];
  canVerify: boolean;
  canWork: boolean;
  canReassign: boolean;
  canOverride: boolean;
  overrideAllowed: boolean;
  /** The clock, read once on the server. A client may not read it in render. */
  nowMs: number;
}) {
  const [verifying, setVerifying] = React.useState(false);

  const ladder = ladderFor(record.salesType);
  const here = ladder.indexOf(record.stage);
  const byStage = new Map(verdicts.map((v) => [v.to, v]));
  const next = here >= 0 ? ladder[here + 1] : ladder[0];
  const nextVerdict = next ? byStage.get(next) : undefined;

  const detail =
    [record.companyName, record.city].filter(Boolean).join(" · ") || record.mobile || "—";

  return (
    <div className="p-6">
      <ScreenHeader
        title={record.name}
        subtitle={
          <>
            {detail}
            {record.contactPerson ? ` · ask for ${record.contactPerson}` : ""}
            {record.mobile ? ` · ${record.mobile}` : ""}
          </>
        }
        actions={
          <Link
            href="/sales/leads"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      {/* ---------------------------------------------------------- header */}

      <section className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3.5 rounded-[6px] border border-line bg-surface px-5 py-3.5">
        <Fact label="Sales type" value={salesTypeLabel(record.salesType)}>
          {record.salesType ? null : (
            <span
              className="text-[12px] text-muted"
              title="Raised before the funnel existed. It climbs the original six rungs and nothing backfills a type."
            >
              on the original ladder
            </span>
          )}
        </Fact>
        <Fact label="Stage" value={stageLabel(record.stage)}>
          <span className="block max-w-[280px] text-[12px] text-pretty text-muted">
            {stageSentence(record.stage)}
          </span>
        </Fact>
        <Fact
          label="Here since"
          value={record.stageSince ? shortDate(record.stageSince) : "—"}
          sub={record.stageSince ? `${plural(record.stuckDays, "day")} on this rung` : undefined}
        />
        <Fact label="Salesman" value={record.salesmanName ?? "Nobody"}>
          {record.salesmanId ? (
            <Link
              href={`/sales/people/${record.salesmanId}`}
              className="block text-[12px] no-underline"
            >
              their record
            </Link>
          ) : (
            <span className="text-[12px] text-warn-ink">unassigned</span>
          )}
        </Fact>
        <Fact
          label="Lead manager"
          value={record.leadManagerName ?? "Nobody"}
          sub={
            record.leadManagerName
              ? "owes the verification call and the nurture tasks"
              : "no territory covers this lead"
          }
        />
        <Fact
          label="Verified"
          value={record.verifiedAt ? shortDate(record.verifiedAt.toString()) : "Not yet"}
          sub={record.verifiedByName ?? undefined}
        />
        <Fact
          label="Potential"
          value={record.potentialPaise ? money(record.potentialPaise) : "Not estimated"}
          sub={record.monthlyLitres ? `${record.monthlyLitres} L a month` : undefined}
        />
      </section>

      {mustDecide ? (
        <Banner
          tone="warn"
          title="This suspect is out of visits"
          body="The window has run out, so nothing is being refused — something is being demanded. Somebody has to answer Prospect or Not Prospect, and both of those are moves the rules allow."
        />
      ) : null}

      {record.stage === "prospect" && !record.verifiedAt ? (
        <Banner
          tone="warn"
          title="Waiting on the verification call"
          body="Qualification does not open until a sales manager has rung the customer. Every day this sits here is a day the salesman cannot move."
          action={
            <Button
              tone="primary"
              disabled={!canVerify}
              title={
                canVerify
                  ? undefined
                  : "The verification call is a sales manager's. Yours is not one of the hats that carries it."
              }
              onClick={() => setVerifying(true)}
            >
              Make the call
            </Button>
          }
        />
      ) : null}

      {record.lostReason ? (
        <Banner tone="danger" title="This lead is closed" body={record.lostReason} />
      ) : null}

      {/* ---------------------------------------------------------- ladder */}

      <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
        <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          The climb
        </div>
        <p className="mb-3 max-w-[620px] text-[12px] text-pretty text-muted">
          Every rung of this lead&rsquo;s own ladder, with what each one is waiting on. Drawn whole
          rather than one step at a time — the question about a stalled lead is where it stopped,
          and that is not answerable from the next button alone.
        </p>

        <ol className="m-0 list-none p-0">
          {ladder.map((stage, i) => {
            const v = byStage.get(stage);
            const past = here >= 0 && i < here;
            const current = i === here;
            return (
              <li
                key={stage}
                className={cx(
                  "flex gap-3 border-l-[3px] py-2 pl-3",
                  current
                    ? "border-brand bg-brand-soft"
                    : past
                      ? "border-success"
                      : "border-divider",
                )}
              >
                <span className="mt-[3px] w-[26px] flex-none text-[12px] tabular-nums text-muted">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-ink">{stageLabel(stage)}</span>
                    {current ? <Pill tone="brand">Here now</Pill> : null}
                    {past ? <Pill tone="success">Done</Pill> : null}
                    {!past && !current && v ? (
                      v.open ? (
                        <Pill tone="success">Open</Pill>
                      ) : (
                        <Pill tone="warn">{plural(v.missing.length, "thing")} missing</Pill>
                      )
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-pretty text-muted">
                    {stageSentence(stage)}
                  </span>
                  {!past && v && !v.open && v.missing.length ? (
                    <ul className="mt-1.5 mb-0 list-none p-0">
                      {v.missing.map((c) => (
                        <li key={c.id} className="text-[12px] text-warn-ink">
                          · {c.says}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-divider pt-3">
          <AdvanceStage
            customerId={record.customerId}
            to={next ?? null}
            verdict={nextVerdict}
            canWork={canWork}
            canOverride={canOverride && Boolean(next) && !nextVerdict?.open}
            overrideAllowed={overrideAllowed}
          />
          <span className="text-[12px] text-muted">
            An override is allowed, recorded, and names what was ignored — a system that refuses
            everything is defeated in a week by people writing work down after the event.
          </span>
        </div>
      </section>

      {/* ------------------------------------------------- two-column body */}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <QualificationPanel record={record} />

          <CommunicationPanel
            customerId={record.customerId}
            documents={documents}
            history={communications}
            disabled={!canWork}
            disabledReason="Working a lead is the salesman's and the manager's."
          />

          <FirstOrderPanel
            customerId={record.customerId}
            expectedOrderDate={record.expectedOrderDate}
            expectedOrderValuePaise={record.expectedOrderValuePaise}
            countingOrderCount={record.countingOrderCount}
            disabled={!canWork}
            disabledReason="Working a lead is the salesman's and the manager's."
          />

          <LedgerPanel record={record} orders={orders} receipts={receipts} />

          <TimelinePanel rows={timeline} total={timelineTotal} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <NextActionPanel record={record} nowMs={nowMs} />
          <VerificationPanel
            record={record}
            calls={calls}
            canVerify={canVerify}
            onStart={() => setVerifying(true)}
          />
          {record.salesType === "distributor" ? (
            <AppointmentPanel record={record} />
          ) : (
            <SamplePanel record={record} />
          )}
          <NurturePanel nurture={nurture} />
          <HandoverPanel
            customerId={record.customerId}
            leadName={record.name}
            stage={record.stage}
            salesType={record.salesType}
            convertedAt={record.convertedAt}
            leadManagerName={record.leadManagerName}
            currentOwnerId={record.salesAmId ?? record.salesmanId}
            currentOwnerName={record.salesAmName ?? record.salesmanName}
            candidates={handover}
            canWork={canWork}
            canReassign={canReassign}
          />
          <HistoryPanel transitions={transitions} />
        </div>
      </div>

      {/* Keyed on the lead so the form remounts with fresh state rather than
          having an effect reset it — the React Compiler rules are on. */}
      <VerificationForm
        key={record.customerId}
        customerId={record.customerId}
        customerName={record.name}
        detail={detail}
        known={[
          record.competitor ? { label: "Using", value: record.competitor } : null,
          record.monthlyLitres
            ? { label: "A month", value: `${record.monthlyLitres} L` }
            : null,
          record.requiredProductName
            ? { label: "Wants", value: record.requiredProductName }
            : null,
          record.salesmanName ? { label: "Visited by", value: record.salesmanName } : null,
        ].filter((k): k is { label: string; value: string } => Boolean(k))}
        open={verifying}
        onClose={() => setVerifying(false)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function Fact({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <span className="block min-w-0">
      <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
        {label}
      </span>
      <span className="block text-[15px] font-medium text-ink">{value}</span>
      {sub ? <span className="block text-[12px] text-muted">{sub}</span> : null}
      {children}
    </span>
  );
}

function Panel({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            {title}
          </div>
          {hint ? (
            <p className="mt-1 max-w-[520px] text-[12px] text-pretty text-muted">{hint}</p>
          ) : null}
        </div>
        {action ? <div className="flex-none">{action}</div> : null}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * §6 §9 §11 — what the salesman answered, and what is missing.
 *
 * The checklist comes from `checklistFor`, which is the SAME list the gate
 * refuses on. A screen with its own copy is how somebody ticks their way to the
 * bottom of a list and is still refused, which is the failure that makes people
 * stop trusting a checklist at all.
 *
 * Four of the twelve are answered by real columns rather than a tick, so those
 * are drawn with the value rather than a mark: a tick beside an empty field is
 * exactly the state this whole engine exists to stop.
 */
function QualificationPanel({ record }: { record: LeadRecord }) {
  const conditions = checklistFor(record.salesType, "qualification");
  const columnAnswers: Record<string, string | number | null> = {
    gst_verified: record.gstin,
    monthly_requirement: record.monthlyLitres,
    monthly_potential: record.potentialPaise ? money(record.potentialPaise) : null,
    required_product: record.requiredProductName,
    competitor_identified: record.competitor,
    credit_days: record.creditDaysWanted,
    decision_maker: record.decisionMaker,
    application_understood: record.application,
  };

  if (!conditions.length) {
    return (
      <Panel
        title="Qualification"
        hint="Nothing to qualify on the original ladder — these leads predate the funnel and climb the six rungs they were raised on."
      >
        <p className="text-[13px] text-muted">No checklist applies.</p>
      </Panel>
    );
  }

  const answered = conditions.filter((c) => {
    const col = columnAnswers[c.id];
    if (col !== undefined) return Boolean(col);
    const q = record.qualification?.[c.id];
    return typeof q === "string" ? q.trim().length > 0 : Boolean(q);
  });

  return (
    <Panel
      title="Qualification"
      hint={`What has to be known before anybody gives them a sample. ${answered.length} of ${conditions.length} answered — the same list the gate refuses on, so ticking to the bottom cannot leave you refused.`}
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 md:grid-cols-2">
        {conditions.map((c) => {
          const col = columnAnswers[c.id];
          const fromColumn = col !== undefined;
          const q = record.qualification?.[c.id];
          const ok = fromColumn
            ? Boolean(col)
            : typeof q === "string"
              ? q.trim().length > 0
              : Boolean(q);
          return (
            <div key={c.id} className="flex items-baseline gap-2">
              <span
                className={cx(
                  "mt-[1px] inline-block h-[7px] w-[7px] flex-none rounded-full",
                  ok ? "bg-success" : "bg-warn",
                )}
              />
              <span className="min-w-0">
                <span className="block text-[13px] text-body">{c.says}</span>
                <span className="block truncate text-[12px] text-muted">
                  {ok
                    ? fromColumn
                      ? String(col)
                      : typeof q === "string"
                        ? q
                        : "Recorded"
                    : "Not answered"}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/**
 * §24 — what happens next, on what day, and who is doing it.
 *
 * All three parts or none: a date with nobody against it is how a lead sits for
 * six weeks with everyone assuming somebody else has it. An outcome that is
 * still empty past the date is drawn as overdue rather than as a plan.
 */
function NextActionPanel({ record, nowMs }: { record: LeadRecord; nowMs: number }) {
  const complete =
    Boolean(record.nextAction) &&
    Boolean(record.nextActionDate) &&
    Boolean(record.nextActionOwnerId);
  const overdue =
    Boolean(record.nextActionDate) &&
    !record.nextActionOutcome &&
    new Date(`${record.nextActionDate}T00:00:00+05:30`).getTime() < nowMs;

  return (
    <Panel
      title="Next action"
      hint="An active lead may not sit with nothing owed by anybody. That is the standing rule, not a field on a form."
    >
      {!complete ? (
        <p className="text-[13px] text-warn-ink">
          Nothing is planned. This lead is on the exception list until somebody names an action, a
          day and a person.
        </p>
      ) : (
        <>
          <div className="text-[14px] text-ink">{record.nextAction}</div>
          <div className="mt-0.5 text-[13px] text-body">
            {shortDate(record.nextActionDate!)} · {record.nextActionOwnerName ?? "somebody"}
            {overdue ? (
              <span className="ml-1.5">
                <Pill tone="warn">Past its day</Pill>
              </span>
            ) : null}
          </div>
          {record.nextActionOutcome ? (
            <div className="mt-1.5 text-[13px] text-muted">
              Outcome: {record.nextActionOutcome}
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}

/** §8 — what the manager asked and what the customer said, kept in full. */
function VerificationPanel({
  record,
  calls,
  canVerify,
  onStart,
}: {
  record: LeadRecord;
  calls: ManagerCall[];
  canVerify: boolean;
  onStart: () => void;
}) {
  return (
    <Panel
      title="Verification"
      hint="The verdict is worth little a month later. The answers are the point — which competitor he named is exactly what somebody needs before the negotiation call."
      action={
        <Button
          size="sm"
          tone={record.verifiedAt ? "default" : "primary"}
          disabled={!canVerify}
          title={
            canVerify
              ? undefined
              : "The verification call is a sales manager's. Yours is not one of the hats that carries it."
          }
          onClick={onStart}
        >
          {calls.length ? "Call again" : "Make the call"}
        </Button>
      }
    >
      {calls.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nobody has rung this customer yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {calls.map((c) => (
            <div key={c.id} className="border-b border-divider pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                {c.verified === true ? (
                  <Pill tone="success">Verified</Pill>
                ) : c.verified === false ? (
                  <Pill tone="warn">Follow-up required</Pill>
                ) : (
                  <Pill tone="neutral">In progress</Pill>
                )}
                <span className="text-[12px] text-muted">
                  {stamp(c.calledAt)} · {c.managerName ?? "a manager"}
                </span>
              </div>
              {c.followUpNote ? (
                <p className="mt-1 text-[13px] text-pretty text-body">{c.followUpNote}</p>
              ) : null}
              <dl className="mt-1.5 mb-0 grid grid-cols-1 gap-x-4 gap-y-0.5">
                {VERIFICATION_QUESTIONS.filter((q) => c.answers?.[q.id]).map((q) => (
                  <div key={q.id} className="flex gap-2 text-[12px]">
                    <dt className="flex-none text-muted">{q.ask}</dt>
                    <dd className="m-0 min-w-0 text-body">{c.answers[q.id]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** §15 §16 — the trial, as it stands on this lead. */
function SamplePanel({ record }: { record: LeadRecord }) {
  const s = record.sample;
  return (
    <Panel
      title="Sample"
      hint="A sample with no feedback is stock given away."
      action={
        <Link
          href="/sales/samples/desk"
          className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
        >
          The desk
        </Link>
      }
    >
      {!s ? (
        <p className="text-[13px] text-muted">
          None asked for. A trial is requested on the visit where the customer asked for one — a
          sample nobody wanted is stock given away with nothing to review.
        </p>
      ) : (
        <div className="text-[13px]">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Pill tone={s.state === "reviewed" ? "success" : "brand"}>
              {sampleStateLabel(s.state as SampleState)}
            </Pill>
            {s.reviewChaseCount > 0 ? (
              <Pill tone="warn">Asked {plural(s.reviewChaseCount, "time")}</Pill>
            ) : null}
          </div>
          <div className="text-body">
            {s.quantityCans ? `${plural(s.quantityCans, "can")} of ` : ""}
            {s.productName ?? "a product nobody named"}
          </div>
          <div className="text-muted">
            {s.expectedDeliveryDate ? `Promised ${shortDate(s.expectedDeliveryDate)}` : "No delivery date promised"}
            {s.receivedConfirmedAt ? ` · received ${stamp(s.receivedConfirmedAt)}` : " · not confirmed received"}
          </div>
          {!s.feedbackRecorded ? (
            <p className="mt-1.5 text-[12px] text-warn-ink">
              Nothing recorded about what they thought. Negotiation does not open until it is —
              the seven answers are on {FEEDBACK_FIELDS.length} fields on the desk.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** §11 §12 — where the appointment stands, and what forced a second signature. */
function AppointmentPanel({ record }: { record: LeadRecord }) {
  const p = (record.distributorProfile ?? {}) as Record<string, unknown>;
  return (
    <Panel
      title="Distributor appointment"
      hint="Thirty answers, then two signatures. A sales manager may recommend one and may not appoint one."
      action={
        <Link
          href="/sales/leads/appointments"
          className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
        >
          The queue
        </Link>
      }
    >
      <div className="flex flex-col gap-1.5 text-[13px]">
        <Step
          done={record.managementReviewApproved}
          label="Sales manager's review"
          detail="Step 0 — the person who knows the territory."
        />
        <Step
          done={Boolean(record.commercialTermsAgreedAt)}
          label="Commercial terms agreed"
          detail={
            record.commercialTermsAgreedAt
              ? `${p.specialDiscountPercent ? `${p.specialDiscountPercent}% discount` : "No special discount"} · ${
                  p.agreedCreditLimitPaise
                    ? money(Number(p.agreedCreditLimitPaise))
                    : "no credit limit"
                } · ${p.exclusivityGranted ? "exclusive" : "not exclusive"}`
              : "Discount, credit limit and exclusivity — the three that force a second signature."
          }
        />
        <Step
          done={record.distributorApprovalApproved}
          label="Management's appointment"
          detail="Step 1. Billable from here."
        />
        <Step
          done={record.agreementOnFile}
          label="Agreement on file"
          detail="A signed document against this account in the library."
        />
      </div>
    </Panel>
  );
}

function Step({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={cx(
          "mt-[1px] inline-block h-[7px] w-[7px] flex-none rounded-full",
          done ? "bg-success" : "bg-divider",
        )}
      />
      <span className="min-w-0">
        <span className="block text-body">{label}</span>
        <span className="block text-[12px] text-pretty text-muted">{detail}</span>
      </span>
    </div>
  );
}

/**
 * §19 §20 — what the ledger says, rendered rather than restated.
 *
 * There is no funnel-owned order status here and there must not be one.
 * `orders.status` is written by the sheet projection and by accounts'
 * approval; a second ladder over it would be overwritten every thirty minutes
 * or fill `sync_conflicts` with a disagreement nobody asked for. And an
 * `unstated` bill is shown as exactly that rather than as a balance: rendering
 * an unknown beside real ones presents it as a debt.
 */
function LedgerPanel({
  record,
  orders,
  receipts,
}: {
  record: LeadRecord;
  orders: LeadOrderRow[];
  receipts: LeadReceiptRow[];
}) {
  return (
    <Panel
      title="Orders and money"
      hint="Read off the ledger as it stands. The funnel does not write an order status — accounts and the order sheet do, and a second copy would be overwritten within the half hour."
    >
      <div className="mb-3 flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
        <Fact label="Counting orders" value={String(record.countingOrderCount)} />
        <Fact label="Dispatched" value={String(record.deliveredOrderCount)} />
        <Fact label="Confirmed receipts" value={String(record.confirmedPaymentCount)} />
        <Fact
          label="Outstanding"
          value={record.outstandingPaise ? money(record.outstandingPaise) : "Nothing owing"}
        />
      </div>

      {orders.length === 0 ? (
        <p className="text-[13px] text-muted">
          No order on this account. Everything above this rung is a plan until there is one.
        </p>
      ) : (
        <Table
          minWidth={820}
          head={
            <>
              <HeadCell width={140}>Order</HeadCell>
              <HeadCell width={120}>Taken</HeadCell>
              <HeadCell align="right" width={120}>Value</HeadCell>
              <HeadCell width={140}>Status</HeadCell>
              <HeadCell width={150}>Bill</HeadCell>
              <HeadCell align="right" width={150}>Balance</HeadCell>
            </>
          }
        >
          {orders.map((o, i) => (
            <Row key={o.id} striped={i % 2 === 1}>
              <Cell truncate={140}>{o.orderNo ?? o.id.slice(0, 8)}</Cell>
              {/* The date alone: a CRM order is stamped 09:00 on the day it is
                  FOR, and printing that clock beside a name reads as a claim
                  about when somebody took the call. */}
              <Cell>{shortDate(o.orderedAt)}</Cell>
              <Cell align="right">{money(o.totalAmountPaise)}</Cell>
              <Cell>
                <Pill
                  tone={
                    o.status === "dispatched"
                      ? "success"
                      : o.status === "declined" || o.status === "cancelled"
                        ? "danger"
                        : o.status === "pending_approval"
                          ? "warn"
                          : "neutral"
                  }
                >
                  {o.status.replace(/_/g, " ")}
                </Pill>
                {o.declineReason ? (
                  <span className="block truncate text-[12px] text-muted">{o.declineReason}</span>
                ) : null}
              </Cell>
              <Cell truncate={150}>
                {o.billNo ?? <span className="text-muted">Not billed</span>}
              </Cell>
              <Cell align="right">
                {o.billAmountPaise == null ? (
                  <span className="text-muted">—</span>
                ) : o.billPaymentPosition === "unstated" ? (
                  <span
                    className="text-muted"
                    title="No payment has been recorded either way. This is not a debt and it is not settled — it is a bill nobody has spoken for."
                  >
                    Not stated
                  </span>
                ) : (
                  money(o.billAmountPaise - (o.billPaidPaise ?? 0))
                )}
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      {receipts.length ? (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Money against this account
          </div>
          <ul className="m-0 list-none p-0">
            {receipts.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline gap-2 border-b border-divider py-1.5 text-[13px] last:border-b-0"
              >
                <span className="font-medium text-ink">{money(r.amountPaise)}</span>
                <span className="text-muted">{shortDate(r.receivedAt)}</span>
                <span className="text-muted">{r.mode}</span>
                {r.reference ? <span className="text-muted">{r.reference}</span> : null}
                <Pill
                  tone={
                    r.status === "confirmed"
                      ? "success"
                      : r.status === "rejected" || r.status === "reversed"
                        ? "danger"
                        : "warn"
                  }
                >
                  {r.status}
                </Pill>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] text-muted">
            Only a confirmed receipt is money the business has seen. A reported one stops the
            chasing and moves no figure.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}

/** §13 — the schedule for this lead alone. */
function NurturePanel({ nurture }: { nurture: NurtureSchedule }) {
  const rows = [...nurture.overdue, ...nurture.today, ...nurture.ahead];
  return (
    <Panel
      title="Nurture"
      hint="What the sequence has raised against this lead. A schedule nobody can see is one nobody trusts."
      action={
        <Link
          href="/sales/leads/nurture"
          className="inline-flex h-[30px] items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
        >
          All of it
        </Link>
      }
    >
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nothing outstanding against this lead
          {nurture.counts.done ? `, and ${plural(nurture.counts.done, "task")} done` : ""}.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.slice(0, 8).map((t) => (
            <li key={t.id} className="border-b border-divider py-1.5 last:border-b-0">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="text-[13px] text-body">{t.title}</span>
                {t.dueInDays != null && t.dueInDays < 0 ? (
                  <Pill tone="warn">{plural(-t.dueInDays, "day")} late</Pill>
                ) : t.dueInDays === 0 ? (
                  <Pill tone="brand">Today</Pill>
                ) : null}
              </span>
              <span className="block text-[12px] text-muted">
                {t.assignedToName ?? "unassigned"}
                {t.dueDate ? ` · ${shortDate(t.dueDate)}` : " · no day named"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** §25 — every stage move, and what a manager ignored to make one. */
function HistoryPanel({ transitions }: { transitions: LeadTransition[] }) {
  const reasonLists = [PROSPECT_REASONS, SAMPLE_REASONS, LOST_REASONS, OVERRIDE_REASONS];
  function reasonLabel(code: string | null) {
    if (!code) return null;
    for (const list of reasonLists) {
      const hit = list.find((r) => r.code === code);
      if (hit) return hit.label;
    }
    return labelOf(OVERRIDE_REASONS, code);
  }

  return (
    <Panel title="Stage history" hint="Every move, who made it, and under which hat.">
      {transitions.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing recorded. The lead is where it was raised.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {transitions.map((t) => (
            <li key={t.id} className="border-b border-divider py-2 last:border-b-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-ink">
                  {t.fromStage ? `${stageLabel(t.fromStage)} → ` : ""}
                  {stageLabel(t.toStage)}
                </span>
                {t.kind === "overridden" ? <Pill tone="warn">Overridden</Pill> : null}
                {t.kind === "reverted" ? <Pill tone="neutral">Reverted</Pill> : null}
              </span>
              <span className="block text-[12px] text-muted">
                {stamp(t.at)} · {t.actorName ?? "somebody"}
                {t.actorRole ? ` as ${t.actorRole}` : ""}
                {reasonLabel(t.reasonCode) ? ` · ${reasonLabel(t.reasonCode)}` : ""}
              </span>
              {t.note ? <span className="block text-[12px] text-body">{t.note}</span> : null}
              {t.overriddenConditions?.length ? (
                <span className="block text-[12px] text-warn-ink">
                  Ignored: {t.overriddenConditions.join(", ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * §25 — the shared timeline, capped, saying what it is a slice of.
 *
 * The count is the table's own `count(*)`, not the length of what was loaded:
 * a capped read that counted itself would print "12 entries" against an account
 * with a thousand and nothing on the screen would say so.
 */
function TimelinePanel({ rows, total }: { rows: TimelineRow[]; total: number }) {
  return (
    <Panel
      title="Timeline"
      hint={
        total > rows.length
          ? `The newest ${rows.length} of ${total}. Visits, calls, orders, money and complaints, from every app.`
          : "Visits, calls, orders, money and complaints, from every app."
      }
    >
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing has happened to this account yet.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((e) => (
            <li key={e.id} className="border-b border-divider py-1.5 last:border-b-0">
              <span className="flex flex-wrap items-baseline gap-2">
                <Pill tone="neutral">{e.eventType}</Pill>
                <span className="text-[13px] text-body">{e.summary}</span>
              </span>
              <span className="block text-[12px] text-muted">
                {stamp(e.occurredAt)}
                {e.actorName ? ` · ${e.actorName}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
