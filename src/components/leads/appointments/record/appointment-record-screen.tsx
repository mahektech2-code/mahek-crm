"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { groupIndian, money, parseRupees, stamp } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stageLabel, stageSentence } from "@/lib/lead-labels";
import { DISTRIBUTOR_LADDER } from "@/lib/engines/lead-ladder";
import { checklistFor, type Condition, type GateVerdict } from "@/lib/engines/lead-gates";
import type {
  AppointmentStep,
  DistributorAppointmentRecord,
  DistributorProfileRow,
  DistributorSalesmanRow,
} from "@/lib/services/distributor-appointment-service";
import {
  agreeCommercialTerms,
  decideDistributorAppointment,
  sendBackForCorrection,
} from "@/lib/actions/distributor-appointment";
import { Banner, Button, Empty, MetricRow, Pill, ScreenHeader } from "@/components/console/parts";
import { waitingWords } from "@/components/console/words";

/* The five groups §11 is written in, with the spec's own headings. Read off
   the conditions themselves rather than retyped beside them — a group added to
   `DISTRIBUTOR_CONDITIONS` appears here by existing. */
const GROUP_TITLES: Record<string, string> = {
  legal: "Business and legal",
  capability: "Distribution capability",
  commercial: "Commercial capability",
  territory: "Territory",
  commitment: "Commitment",
};

/**
 * The three things §12 names, said in the words the stored code means — and the
 * fourth, which names nothing.
 *
 * `standard` is what a step 1 row carries when none of the three triggers
 * applied. Management review every appointment, so the row exists either way;
 * what the triggers decide is whether there was a reason BEYOND the ordinary
 * one. The specification's own wording for the fallback is "standard review",
 * and it is spelled out here rather than left to the `replace(/_/g, " ")`
 * default underneath, which would print the bare word "standard" against a
 * label reading "Why this step" and answer nothing.
 *
 * `normal` is the step 0 row's, written by `submitForManagementReview` since
 * the module shipped. It is included so the sales manager's own step does not
 * fall through to the raw code either.
 */
const ROUTE_REASON_WORDS: Record<string, string> = {
  exclusivity: "Territory exclusivity is being granted",
  over_discount: "The discount is above what a sales manager may allow",
  over_credit_limit: "The credit limit is above what a sales manager may allow",
  standard: "Standard review — management sign every appointment",
  normal: "The sales manager's own step, which every candidate has",
};

/*
 * `sendBack` is a third thing to do with a step and deliberately not a third
 * shade of `decide`. Approving and refusing are two answers to one question;
 * sending back declines to answer it, leaves the row pending and leaves the
 * sales stage exactly where it is. Folding it into the decide branch as a
 * third boolean is how the two would come to share a code path and, eventually,
 * a stage move — which is the one thing Mahek asked this not to do.
 */
type Acting =
  | { kind: "decide"; step: AppointmentStep; approve: boolean }
  | { kind: "sendBack"; step: AppointmentStep }
  | { kind: "terms" };

/**
 * One distributor candidate, end to end.
 *
 * **The record is READABLE to anybody holding the module and DECIDABLE by
 * almost nobody**, and that asymmetry is deliberate rather than an oversight. A
 * sales manager reviews a candidate he may not appoint; a lead manager reads
 * one to know what to chase. A queue you can see and a decision you cannot make
 * is the correct shape for somebody who reviews without approving — hiding the
 * record from them would mean the only people who can read an application are
 * the two who sign it, and the salesman who assembled it could never check his
 * own work.
 *
 * **Every control that is off says why in a `title`.** A button that is simply
 * absent teaches nothing: the reader concludes the screen is broken or the
 * appointment is stuck, and rings somebody about it. The refusals themselves
 * live in `decideDistributorAppointment` and `agreeCommercialTerms`, because a
 * server action is a URL and a hidden control is not a permission.
 *
 * **Nothing here re-derives the routing rule.** `approvalRouteReason` decides
 * whether management is required and the page hands the answer down; this file
 * only prints it. The thresholds are printed too, so the reason can be checked
 * against the numbers rather than believed.
 */
export function AppointmentRecordScreen({
  workspace,
  record,
  verdict,
  routeReason,
  discountThreshold,
  creditLimitThresholdPaise,
  canApproveManagement,
  canChangeTerms,
  nowMs,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  record: DistributorAppointmentRecord;
  /** Entering `management_review` — the rung the thirty answers buy. */
  verdict: GateVerdict;
  /** From `approvalRouteReason`, and from nowhere else. */
  routeReason: string | null;
  discountThreshold: number;
  creditLimitThresholdPaise: number;
  canApproveManagement: boolean;
  canChangeTerms: boolean;
  /** The clock, read once on the server — a client may not read it in render. */
  nowMs: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const { candidate, profile, steps, salesmen, moves } = record;

  const [acting, setActing] = React.useState<Acting | null>(null);
  const [note, setNote] = React.useState("");
  const [discount, setDiscount] = React.useState("");
  const [creditLimit, setCreditLimit] = React.useState("");
  const [exclusivity, setExclusivity] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function begin(next: Acting) {
    setActing(next);
    setNote("");
    setError(null);
    if (next.kind === "terms") {
      setDiscount(profile?.specialDiscountPercent != null ? String(profile.specialDiscountPercent) : "");
      /* Rupees in the box, paise on the wire. The division happens here, in the
         one place a person types a figure, and never on the way to a screen —
         `money()` is what renders paise everywhere else. */
      setCreditLimit(
        profile?.agreedCreditLimitPaise != null
          ? String(Math.round(profile.agreedCreditLimitPaise / 100))
          : "",
      );
      setExclusivity(Boolean(profile?.exclusivityGranted));
    }
  }

  async function submit() {
    if (!acting) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result =
        acting.kind === "decide"
          ? await decideDistributorAppointment(acting.step.approvalId, {
              approve: acting.approve,
              note: note.trim(),
            })
          : acting.kind === "sendBack"
          ? await sendBackForCorrection(acting.step.approvalId, { note: note.trim() })
          : await agreeCommercialTerms(candidate.customerId, {
              discountPercent: Number(discount) || 0,
              creditLimitPaise: parseRupees(creditLimit) ?? 0,
              exclusivity,
              note: note.trim(),
            });
    } finally {
      /* Cleared whatever happened: an action that rejects rather than returning
         a Result would otherwise leave the button dead. */
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setActing(null);
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  const managerStep = steps.find((s) => s.stepIndex === 0) ?? null;
  const managementStep = steps.find((s) => s.stepIndex >= 1) ?? null;
  const managerSaidYes =
    managerStep?.state === "approved" || managerStep?.state === "partially_approved";

  const conditions = checklistFor("distributor", "qualification");
  const missingIds = new Set(verdict.missing.map((c) => c.id));
  const metCount = conditions.filter((c) => !missingIds.has(c.id)).length;
  /* §24 rides in on the same verdict — an active lead may not sit with nothing
     owed by anybody — and it is not one of the thirty, so it is drawn on its
     own rather than swelling the count. */
  const otherMissing = verdict.missing.filter(
    (c) => !conditions.some((k) => k.id === c.id),
  );

  /* The clock came down as a number from the server, and the wait is measured
     here rather than in SQL because the record reads one candidate — a
     subquery per row buys nothing when there is one row. `requestedAt` may
     arrive as a string: `db.execute` hands back a timestamptz as text whatever
     the type annotation says, so it is parsed rather than trusted to be a Date. */
  const waitingHours = steps
    .filter((s) => s.state === "pending")
    .reduce((n, s) => {
      const at = new Date(s.requestedAt).valueOf();
      return Number.isFinite(at) ? Math.max(n, Math.floor((nowMs - at) / 3_600_000)) : n;
    }, 0);

  /* The send-backs that are still outstanding, which is a different question
     from "has this ever been sent back". The marks are cleared the moment the
     step is acted on, so anything still here is work somebody owes RIGHT NOW —
     and it is drawn at the top of the record rather than only on the step card,
     because a note that only exists three sections down is one the salesman
     scrolls past on his way to the thirty conditions he is about to re-read for
     no reason. The history of what was sent back and when lives on the
     customer's timeline, which is where a record of the past belongs. */
  const outstandingSendBacks = steps.filter((s) => s.state === "pending" && s.sentBackNote);

  const rung = DISTRIBUTOR_LADDER.indexOf(candidate.stage);
  const approvalRung = DISTRIBUTOR_LADDER.indexOf("distributor_approval");

  return (
    <div className="p-6">
      <ScreenHeader
        title={candidate.name}
        subtitle={
          <>
            {[candidate.companyName, candidate.area, candidate.city].filter(Boolean).join(" · ") ||
              "No company or town recorded"}
            {candidate.contactPerson ? ` · ask for ${candidate.contactPerson}` : ""}
            {candidate.mobile ? ` · ${candidate.mobile}` : ""}
          </>
        }
        actions={
          <span className="flex gap-2">
            <Link
              href={leadHref(workspace, `leads/${candidate.customerId}`)}
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              The lead record
            </Link>
            <Link
              href={leadHref(workspace, "leads/appointments")}
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ← The queue
            </Link>
          </span>
        }
      />

      {/* --------------------------------------------- the named gaps, first */}

      {candidate.salesType !== "distributor" ? (
        <Banner
          tone="warn"
          title="This candidate is not on the distributor ladder"
          body={
            <>
              Their sales type is{" "}
              {candidate.salesType ? <b>{candidate.salesType.replace(/_/g, " ")}</b> : <b>not set</b>}
              , so the rungs and the thirty conditions below are the ones an appointment would be
              measured against rather than the ones this lead is actually climbing. Nothing
              backfills a sales type — guessing which of three ladders somebody was put on is a
              decision dressed up as a migration, and the ladder decides which gates apply.
            </>
          }
        />
      ) : null}

      {outstandingSendBacks.map((s) => (
        <Banner
          key={s.approvalId}
          tone="warn"
          title={`Step ${s.stepIndex + 1} has been sent back for correction`}
          body={
            <>
              <b>&ldquo;{s.sentBackNote}&rdquo;</b>
              {s.sentBackByName ? ` — ${s.sentBackByName}` : ""}
              {s.sentBackAt ? `, ${stamp(s.sentBackAt)}` : ""}. The request is still open and
              nothing has been decided: the rung below has not moved and does not move for this.
              Correct what it names and the reviewer can answer.
            </>
          }
        />
      ))}

      {waitingHours >= 24 ? (
        <Banner
          tone="warn"
          title={`A signature has been waiting ${waitingWords(waitingHours)}`}
          body="Until it is answered nobody can bill this candidate or send them stock, and the salesman who assembled the application has nothing to go back to them with."
        />
      ) : null}

      <MetricRow
        metrics={[
          {
            label: "Rung",
            value: stageLabel(candidate.stage),
            sub: rung >= 0 ? `${rung + 1} of ${DISTRIBUTOR_LADDER.length}` : "not on this ladder",
          },
          {
            label: "Thirty conditions",
            value: `${metCount} / ${conditions.length}`,
            tone: metCount < conditions.length ? "warn" : undefined,
          },
          {
            label: "Monthly potential",
            value: profile?.monthlyPotentialPaise != null
              ? money(profile.monthlyPotentialPaise)
              : "—",
            sub: profile?.monthlyPotentialPaise == null ? "nobody has judged it" : "their claim",
          },
          {
            label: "Signatures",
            value: `${steps.filter((s) => s.state !== "pending").length} / 2`,
            /* It used to read "manager may be enough" where nothing was above a
               threshold, and that promised a path the gate never had: the
               `distributor_approval` rung has always demanded management's
               signature, so an ordinary candidate told a manager could settle
               it was a candidate nobody could appoint. Both steps, always. */
            sub: routeReason ? "management, and above a threshold" : "management sign every one",
          },
          {
            label: "Their salesmen",
            value: String(salesmen.filter((s) => s.active).length),
            sub: "no MahekOne login, by design",
          },
        ]}
      />

      {/* ------------------------------------------------------ the profile */}

      {profile === null ? (
        <Empty
          title="No application on file"
          body="Nothing has been recorded against this candidate on `distributor_profiles` — not a GST check, not a dealer count, not a territory. The thirty answers §11 asks for are collected on the handset or on the lead record, and until one exists there is nothing for a sales manager to put forward."
          action={
            <Link
              href={leadHref(workspace, `leads/${candidate.customerId}`)}
              className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
            >
              Open the lead record
            </Link>
          }
        />
      ) : (
        <ProfilePanels profile={profile} />
      )}

      {/* -------------------------------------------- the terms and the route */}

      <Section
        title="What is being asked for"
        note="The three figures on the right are the ones §12 names. They are what decide whether a sales manager's signature is enough, and they are the only things on this record that do."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Facts
            title="Asked for"
            rows={[
              ["Credit period", profile?.creditDaysRequired != null ? `${profile.creditDaysRequired} days` : null],
              ["Credit limit", profile?.creditLimitRequiredPaise != null ? money(profile.creditLimitRequiredPaise) : null],
              ["Territory", profile?.proposedTerritory ?? null],
              [
                "Exclusivity",
                profile?.exclusivityRequested == null
                  ? null
                  : profile.exclusivityRequested
                    ? "Asked for"
                    : "Not asked for",
              ],
              ["Would start", profile?.expectedStartDate ?? null],
            ]}
          />
          <Facts
            title={profile?.commercialTermsAgreedAt ? "Agreed" : "Offered — not agreed yet"}
            rows={[
              ["Discount", profile?.specialDiscountPercent != null ? `${profile.specialDiscountPercent}%` : null],
              ["Credit limit", profile?.agreedCreditLimitPaise != null ? money(profile.agreedCreditLimitPaise) : null],
              [
                "Exclusivity",
                profile?.exclusivityGranted == null
                  ? null
                  : profile.exclusivityGranted
                    ? "Granted"
                    : "Not granted",
              ],
              ["Settled", profile?.commercialTermsAgreedAt ? stamp(profile.commercialTermsAgreedAt) : null],
              ["What was agreed", profile?.commercialTermsNote ?? null],
            ]}
            action={
              <Button
                size="sm"
                disabled={!canChangeTerms || profile === null}
                title={
                  profile === null
                    ? "There is no application to attach terms to. The thirty answers come first."
                    : canChangeTerms
                      ? undefined
                      : "Changing what is being offered needs `distributor.terms`. Reading it needs only this screen."
                }
                onClick={() => begin({ kind: "terms" })}
              >
                Terms
              </Button>
            }
          />
        </div>

        {/* THE NAMED ESCALATION REASON. Printed, never re-derived — see the page. */}
        <div className="mt-4 rounded-[6px] border border-line bg-surface px-4 py-3">
          <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Why there are two steps
          </div>
          {profile?.commercialTermsAgreedAt == null ? (
            <p className="mt-1 text-[13px] text-body">
              <b>Nothing has been offered yet, so there is nothing to route on.</b> The routing
              reads the AGREED terms, and until somebody records them this is neither an ordinary
              appointment nor an escalated one — it is an application with no commercial answer in
              it. That is not the same as &ldquo;a sales manager can sign this&rdquo;.
            </p>
          ) : routeReason ? (
            <p className="mt-1 text-[13px] text-body">
              <Pill tone="warn">{routeReason.replace(/_/g, " ")}</Pill>{" "}
              <b>{ROUTE_REASON_WORDS[routeReason] ?? routeReason.replace(/_/g, " ")}.</b> This one
              goes to management. §12 names three things that force a second signature and does not
              leave it to anybody&rsquo;s judgement: exclusivity always, a discount above{" "}
              {discountThreshold}%, or a credit limit above {money(creditLimitThresholdPaise)}.
            </p>
          ) : (
            <p className="mt-1 text-[13px] text-body">
              <b>Standard review.</b> Nothing here is above a threshold and no exclusivity is
              being granted — a discount at or under {discountThreshold}% and a credit limit at or
              under {money(creditLimitThresholdPaise)} — so this is in front of management as an
              ordinary appointment rather than an escalated one. It is still in front of them:
              only management appoint a distributor, whatever the numbers say, and the sales
              manager&rsquo;s step is a recommendation.
            </p>
          )}
          <p className="mt-2 text-[12px] text-muted">
            The second step exists because <b>the person carrying the target must not be the person
            allowing the discount that hits it</b> — the same reasoning that keeps{" "}
            <code>order.approve</code> away from managers entirely. A sales manager may recommend an
            appointment and may not make one.
          </p>
        </div>
      </Section>

      {/* ----------------------------------------------- both approval steps */}

      <Section
        title="The two signatures"
        note="Step 0 is the sales manager, who knows whether that territory already has somebody in it. Step 1 is management. Decided rows are shown as well as waiting ones — a record has to be able to say that step 0 was refused in March, and by whom."
      >
        {steps.length === 0 ? (
          <Empty
            title="Nobody has put this candidate forward"
            body="There is no row on `mbos_approvals` for this appointment at either step. That is not a decision waiting — it is a request that has never been made, which is a different thing and is usually the sales manager not having been asked yet."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <StepCard
              title="Step 0 · Sales manager"
              why="The person who knows the territory."
              step={managerStep}
              /* A sales manager's own step is not gated by `distributor.approve`
                 — that capability is what step 1 needs. Deciding step 0 is the
                 recommendation, and the action is the authority on who may make
                 it; the record only draws the controls. */
              canDecide
              disabledReason={undefined}
              onDecide={(step, approve) => begin({ kind: "decide", step, approve })}
              onSendBack={(step) => begin({ kind: "sendBack", step })}
            />
            <StepCard
              title="Step 1 · Management"
              why="Appointed here, and billable from here."
              step={managementStep}
              canDecide={canApproveManagement && managerSaidYes}
              disabledReason={
                !canApproveManagement
                  ? "Appointing a distributor is management's and admin's, under `distributor.approve`. A sales manager may recommend one and may not make one — that is the whole reason there are two steps."
                  : !managerSaidYes
                    ? "The sales manager has not answered step 0 yet. Deciding ahead of them is deciding somebody else's half."
                    : undefined
              }
              onDecide={(step, approve) => begin({ kind: "decide", step, approve })}
              onSendBack={(step) => begin({ kind: "sendBack", step })}
            />
          </div>
        )}
      </Section>

      {/* ---------------------------------------------- the thirty conditions */}

      <Section
        title="The thirty conditions"
        note="§11, and these are NOT the twelve a direct customer answers. A shop is asked twelve because appointing it is a sale; a distributor is asked thirty because appointing one is a commercial arrangement. The list is `DISTRIBUTOR_CONDITIONS`, read through the same `checklistFor` the gate refuses on — so somebody ticking their way down it cannot arrive at the bottom and still be refused."
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Object.keys(GROUP_TITLES).map((group) => {
            const rows = conditions.filter((c) => c.group === group);
            if (!rows.length) return null;
            return (
              <div key={group} className="rounded-[6px] border border-line bg-surface px-4 py-3">
                <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  {GROUP_TITLES[group]}
                </div>
                <ul className="mt-2 space-y-1.5">
                  {rows.map((c) => (
                    <ConditionLine key={c.id} condition={c} missing={missingIds.has(c.id)} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {otherMissing.length ? (
          <div className="mt-4 rounded-[6px] border border-line bg-surface px-4 py-3">
            <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              And outside the thirty
            </div>
            <ul className="mt-2 space-y-1.5">
              {otherMissing.map((c) => (
                <ConditionLine key={c.id} condition={c} missing />
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted">
              §24 — an active lead may not sit with nothing owed by anybody. The action, the day and
              the person, not a date.
            </p>
          </div>
        ) : null}
      </Section>

      {/* ------------------------------------------------------- the ladder */}

      <Section
        title="Where they are on the ladder"
        note="Nine rungs, and no sample among them: what replaces the trial is two approvals, which is the whole reason this is its own ladder."
      >
        <ol className="rounded-[6px] border border-line bg-surface">
          {DISTRIBUTOR_LADDER.map((stage, i) => {
            const move = moves.find((m) => m.toStage === stage);
            const here = stage === candidate.stage;
            const behind = rung >= 0 && i < rung;
            return (
              <li
                key={stage}
                className={`flex items-baseline gap-3 border-b border-divider px-4 py-2.5 last:border-b-0 ${here ? "bg-brand-soft" : ""}`}
              >
                <span className="w-5 flex-none text-[12px] tabular-nums text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink">
                    {stageLabel(stage)}
                    {here ? <span className="ml-2"><Pill tone="brand">here now</Pill></span> : null}
                    {stage === "distributor_approval" ? (
                      <span className="ml-2"><Pill tone="success">billable from here</Pill></span>
                    ) : null}
                  </span>
                  <span className="block text-[12px] text-muted">{stageSentence(stage)}</span>
                </span>
                <span className="flex-none text-[12px] text-muted">
                  {move
                    ? stamp(move.at)
                    : behind
                      ? "no transition recorded"
                      : ""}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-[12px] text-muted">
          <b>A distributor becomes billable at Approval, not at the agreement</b> — rung{" "}
          {approvalRung + 1} of {DISTRIBUTOR_LADDER.length}, two rungs before the paperwork is on
          file. This is the one people get wrong: the agreement, the initial stock order and Active
          are all things that happen to an account we are already invoicing.
        </p>
      </Section>

      {/* --------------------------------------------- the distributor's men */}

      <Section
        title="Their own salesmen"
        note="§23 — the chain is Mahek → distributor → his salesman → the shop, and it is recorded from the first visit rather than reconstructed at conversion."
      >
        {/*
          THESE PEOPLE HAVE NO MAHEKONE LOGIN AND NEVER WILL, and this is the
          thing somebody will one day try to "fix". Rahul works for the
          distributor. Giving him a `users` row would put him in every person
          picker in the product — the salesperson dropdown, the reassignment
          dialog, the target screen, the approval chain — as somebody who can
          never answer any of them. He is a fact about how a shop is served,
          exactly as `sales_person_name` already is. Do not link these names to
          an account, and do not add one for them.
        */}
        {salesmen.length === 0 ? (
          <Empty
            title="No salesman of theirs recorded"
            body="Nothing on `distributor_salesmen` for this distributor. That is ordinary rather than a fault — a distributor with one counter and no sales team is the commonest case, and the arrangement on a shop may name none. What it does mean is that a shop served through this candidate cannot say WHO serves it."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {salesmen.map((s) => (
              <SalesmanCard key={s.id} salesman={s} />
            ))}
          </div>
        )}
      </Section>

      {/* --------------------------------------------------------- who holds it */}

      <Section title="Who is carrying this" note="Two seats, and only one of them is the book.">
        <Facts
          title="Seats"
          rows={[
            ["Salesman", candidate.salesmanName ?? (candidate.salesmanId ? null : "Unassigned")],
            ["Lead manager", candidate.leadManagerName ?? null],
            [
              "Next action",
              candidate.nextAction
                ? `${candidate.nextAction}${candidate.nextActionDate ? ` — ${candidate.nextActionDate}` : ""}${candidate.nextActionOwnerName ? ` — ${candidate.nextActionOwnerName}` : ""}`
                : null,
            ],
            ["On this rung since", candidate.stageSince ?? null],
          ]}
        />
      </Section>

      {/* ------------------------------------------------------------- decide */}

      <Modal
        open={acting?.kind === "decide"}
        onClose={() => setActing(null)}
        title={
          acting?.kind === "decide" && acting.approve ? "Approve this step" : "Refuse this step"
        }
        width={520}
      >
        {acting?.kind === "decide" ? (
          <>
            <p className="mb-3 text-[13px] text-body">
              {acting.step.stepIndex >= 1
                ? "Step 1. Approving appoints them, and they are billable from this decision — everything after it is paperwork against an account we invoice."
                : "Step 0. This is a recommendation, not an appointment: management still has to sign."}
            </p>
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
                    ? "Goes on the record with the decision"
                    : "The salesman has to be able to go back with something"
                }
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button
                tone={acting.approve ? "primary" : "danger"}
                disabled={busy || (!acting.approve && !note.trim())}
                title={
                  !acting.approve && !note.trim()
                    ? "Say why. A refusal with no reason is a decision nobody can act on."
                    : undefined
                }
                onClick={() => void submit()}
              >
                {busy ? "Saving…" : acting.approve ? "Approve" : "Refuse"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>

      {/* -------------------------------------------------- send it back */}

      <Modal
        open={acting?.kind === "sendBack"}
        onClose={() => setActing(null)}
        title="Send back for correction"
        width={520}
      >
        {acting?.kind === "sendBack" ? (
          <>
            <p className="mb-3 text-[13px] text-body">
              This is not a decision. The request stays open, it stays in the queue, and{" "}
              <b>the rung does not move</b> — the candidate is exactly where they were, with the
              application incomplete. It goes back to whoever raised it, carrying what you write
              here.
            </p>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                What has to be corrected · required
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Name the thing that is missing or wrong. This is the whole message they get."
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
              <span className="mt-1 block text-[12px] text-muted">
                A send-back with no note is &ldquo;do it again&rdquo; with nothing to act on, which
                is worse than the phone call it replaces — so it is refused.
              </span>
            </label>
            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={busy || !note.trim()}
                title={
                  !note.trim()
                    ? "Say what has to be fixed. Without it they are being asked to guess."
                    : undefined
                }
                onClick={() => void submit()}
              >
                {busy ? "Sending…" : "Send back"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>

      {/* -------------------------------------------------- commercial terms */}

      <Modal
        open={acting?.kind === "terms"}
        onClose={() => setActing(null)}
        title="Commercial terms"
        width={520}
      >
        {acting?.kind === "terms" ? (
          <>
            <p className="mb-3 text-[13px] text-body">
              These three are what decide whether a sales manager&rsquo;s signature is enough. Over{" "}
              {discountThreshold}% discount, over {money(creditLimitThresholdPaise)} of credit
              limit, or any exclusivity, and it goes to management.
            </p>

            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">Discount %</span>
                <input
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  inputMode="numeric"
                  className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">Credit limit (₹)</span>
                <input
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  inputMode="numeric"
                  className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
                />
                <span className="mt-1 block text-[12px] text-muted">
                  In rupees. Stored in paise, like every figure here.
                </span>
              </label>
            </div>

            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={exclusivity}
                onChange={(e) => setExclusivity(e.target.checked)}
                className="mt-[3px]"
              />
              <span className="text-[13px]">
                <span className="block text-ink">Territory exclusivity</span>
                <span className="block text-[12px] text-muted">
                  Granting this closes the territory to anybody else, so it always goes to
                  management whatever the numbers say. Asking for it is a different fact, and it is
                  recorded above.
                </span>
              </span>
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[13px] font-medium text-ink">
                What was agreed · required
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
              />
            </label>

            {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-2">
              <Button tone="quiet" onClick={() => setActing(null)}>
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={busy || !note.trim()}
                title={
                  !note.trim()
                    ? "Say what was agreed. The numbers alone do not say what the conversation settled."
                    : undefined
                }
                onClick={() => void submit()}
              >
                {busy ? "Saving…" : "Record the terms"}
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

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
    <section className="mb-6">
      <div className="mb-2">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {note ? <p className="text-[12px] text-pretty text-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A panel of label/value rows where a null is said rather than skipped.
 *
 * An absent row reads as a field that does not exist; "Not answered" reads as a
 * question nobody has put. On an application whose whole purpose is to show
 * what is still missing, the second is the only honest one.
 */
function Facts({
  title,
  rows,
  action,
}: {
  title: string;
  rows: [string, React.ReactNode | null][];
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-4 py-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          {title}
        </div>
        {action ? <div className="flex-none">{action}</div> : null}
      </div>
      <dl className="space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="flex-none text-[12px] text-muted">{label}</dt>
            <dd className="min-w-0 text-right text-[13px] text-ink">
              {value === null || value === undefined || value === "" ? (
                <span className="text-muted">Not answered</span>
              ) : (
                value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The application itself, in §11's own five groups.
 *
 * A yes/no answer is drawn as the WORD rather than as a tick, and an unanswered
 * one says so — `hasWarehouse` and `hasDealerNetwork` are three-valued on
 * purpose, and rendering null as "No" would put a fact on the screen that
 * nobody established. A candidate with no godown is ordinary; a candidate
 * nobody asked about one is not the same candidate.
 */
function ProfilePanels({ profile }: { profile: DistributorProfileRow }) {
  return (
    <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Facts
        title="Verifications"
        rows={[
          ["GST", yesNo(profile.gstVerified, "Verified", "Not verified yet")],
          ["PAN", yesNo(profile.panVerified, "Verified", "Not verified yet")],
          ["PAN number", profile.panNumber],
          ["Address", yesNo(profile.businessAddressVerified, "Verified", "Not verified yet")],
        ]}
      />
      <Facts
        title="The business"
        rows={[
          ["Type", profile.businessType],
          ["Years trading", profile.yearsInBusiness != null ? `${profile.yearsInBusiness}` : null],
          ["Decision maker", profile.decisionMaker],
          ["Carries now", profile.productPortfolio],
          ["Competing brands", profile.competitorBrands],
        ]}
      />
      <Facts
        title="Dealer network"
        rows={[
          ["Has one", maybe(profile.hasDealerNetwork, "Yes", "No")],
          [
            "Active dealers",
            profile.activeDealerCount != null ? `${profile.activeDealerCount}` : null,
          ],
          ["Sales team", profile.salesTeamSize != null ? `${profile.salesTeamSize} people` : null],
          ["Dealer development", profile.dealerDevelopmentCommitment],
        ]}
      />
      <Facts
        title="Territory"
        rows={[
          ["Covers today", profile.territoryCovered],
          ["Cities and markets", profile.citiesCovered],
          ["Asking for", profile.proposedTerritory],
          [
            "Anybody there already",
            profile.existingDistributorChecked ? "Checked" : "Nobody has checked",
          ],
          [
            "Clash",
            profile.territoryConflict == null
              ? null
              : profile.territoryConflict
                ? "Yes — management's to weigh"
                : "None",
          ],
          ["Clash note", profile.territoryConflictNote],
        ]}
      />
      <Facts
        title="Warehouse and delivery"
        rows={[
          ["Godown", maybe(profile.hasWarehouse, "Yes", "No")],
          [
            "Capacity",
            profile.storageCapacityLitres != null
              ? `${groupIndian(profile.storageCapacityLitres)} litres`
              : null,
          ],
          ["Delivers by", profile.deliveryCapability],
        ]}
      />
      <Facts
        title="What they could do"
        rows={[
          ["A month", profile.monthlyPotentialPaise != null ? money(profile.monthlyPotentialPaise) : null],
          [
            "First order",
            profile.initialOrderPotentialPaise != null
              ? money(profile.initialOrderPotentialPaise)
              : null,
          ],
          [
            "Can invest",
            profile.investmentCapacityPaise != null ? money(profile.investmentCapacityPaise) : null,
          ],
          [
            "Will buy monthly",
            profile.expectedMonthlyPurchasePaise != null
              ? money(profile.expectedMonthlyPurchasePaise)
              : null,
          ],
          [
            "Initial stock committed",
            profile.initialStockCommitmentPaise != null
              ? money(profile.initialStockCommitmentPaise)
              : null,
          ],
          [
            "Monthly committed",
            profile.monthlyPurchaseCommitmentPaise != null
              ? money(profile.monthlyPurchaseCommitmentPaise)
              : null,
          ],
        ]}
      />
    </div>
  );
}

function yesNo(v: boolean, yes: string, no: string): React.ReactNode {
  return v ? yes : <span className="text-warn-ink">{no}</span>;
}

/** Three-valued. Null falls through to the "Not answered" the panel draws. */
function maybe(v: boolean | null, yes: string, no: string): React.ReactNode | null {
  if (v === null) return null;
  return v ? yes : no;
}

function ConditionLine({ condition, missing }: { condition: Condition; missing: boolean }) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      <span
        aria-hidden
        className={`mt-[5px] size-1.5 flex-none rounded-full ${missing ? "bg-warn" : "bg-success"}`}
      />
      <span className={missing ? "text-body" : "text-muted line-through"}>{condition.says}</span>
    </li>
  );
}

/**
 * One step, decided or waiting or never asked for.
 *
 * Three states, and the third is the one a screen usually gets wrong: a step
 * with no row is not a step waiting on somebody, it is a request nobody has
 * made. Drawing it as "pending" would put a director on a list he was never
 * put on.
 */
function StepCard({
  title,
  why,
  step,
  canDecide,
  disabledReason,
  onDecide,
  onSendBack,
}: {
  title: string;
  why: string;
  step: AppointmentStep | null;
  canDecide: boolean;
  disabledReason?: string;
  onDecide: (step: AppointmentStep, approve: boolean) => void;
  onSendBack: (step: AppointmentStep) => void;
}) {
  const decided = step && step.state !== "pending";
  /* A sent-back step is still `pending`, so the pill above goes on saying
     "waiting" and is right to. What it cannot say is who it is waiting ON, and
     that is the difference between chasing the reviewer and chasing the
     salesman — so the note is drawn as its own block rather than folded in
     beside the decision note, which is a different sentence about a decision
     that has not been taken. */
  const sentBack = step && !decided && step.sentBackNote ? step : null;
  return (
    <div className="rounded-[6px] border border-line bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <div className="text-[12px] text-muted">{why}</div>
        </div>
        <div className="flex-none">
          {!step ? (
            <Pill>not asked for</Pill>
          ) : decided ? (
            <Pill tone={step.state === "rejected" ? "danger" : "success"}>{step.state}</Pill>
          ) : (
            <Pill tone="warn">waiting</Pill>
          )}
        </div>
      </div>

      {!step ? (
        <p className="mt-2 text-[13px] text-body">
          No row on <code>mbos_approvals</code> for this step. Nobody has asked for this decision,
          so there is nothing here to answer.
        </p>
      ) : (
        <>
          {sentBack ? (
            <div className="mt-2 rounded-[6px] border-l-[3px] border-warn bg-warn-soft px-3 py-2">
              <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                Sent back for correction
              </div>
              <p className="mt-1 text-[13px] text-ink">{sentBack.sentBackNote}</p>
              <p className="mt-1 text-[12px] text-muted">
                {sentBack.sentBackByName ? `${sentBack.sentBackByName}, ` : ""}
                {sentBack.sentBackAt ? stamp(sentBack.sentBackAt) : "date not recorded"} — still
                waiting, and the rung has not moved.
              </p>
            </div>
          ) : null}
          <dl className="mt-2 space-y-1.5">
            <Line label="Asked" value={`${stamp(step.requestedAt)}${step.requestedByName ? ` by ${step.requestedByName}` : ""}`} />
            <Line
              label="Why this step"
              value={
                step.routeReason
                  ? (ROUTE_REASON_WORDS[step.routeReason] ?? step.routeReason.replace(/_/g, " "))
                  : "Ordinary — recorded as needing no escalation"
              }
            />
            {step.reason ? <Line label="Put forward saying" value={step.reason} /> : null}
            <Line
              label="Decided"
              value={
                decided
                  ? `${stamp(step.decidedAt)}${step.approverName ? ` by ${step.approverName}` : ""}`
                  : "Nobody has answered"
              }
            />
            <Line label="Note" value={step.decisionNote ?? "None written"} />
          </dl>

          {!decided ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                tone="primary"
                disabled={!canDecide}
                title={canDecide ? undefined : disabledReason}
                onClick={() => onDecide(step, true)}
              >
                Approve
              </Button>
              <Button
                size="sm"
                tone="danger"
                disabled={!canDecide}
                title={canDecide ? undefined : disabledReason}
                onClick={() => onDecide(step, false)}
              >
                Refuse
              </Button>
              {/* Sending back holds the decision, so it takes the same
                  capability as taking it — which is why it shares `canDecide`
                  rather than being offered more widely. A weaker hat able to
                  turn management's step back would be a way to stall an
                  appointment without the authority to refuse one. */}
              <Button
                size="sm"
                tone="quiet"
                disabled={!canDecide}
                title={
                  canDecide
                    ? "Returns it to whoever raised it with a note saying what to fix. Nothing is decided and the rung does not move."
                    : disabledReason
                }
                onClick={() => onSendBack(step)}
              >
                {sentBack ? "Send back again" : "Send back"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="flex-none text-[12px] text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] text-ink">{value}</dd>
    </div>
  );
}

function SalesmanCard({ salesman }: { salesman: DistributorSalesmanRow }) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        {/* A NAME, not a link. There is no account behind it and there must
            never be one — see the note on this panel above. */}
        <span className="text-[13px] font-medium text-ink">{salesman.name}</span>
        {salesman.active ? null : <Pill>left</Pill>}
      </div>
      <div className="mt-0.5 text-[12px] text-muted">
        {[salesman.mobile, salesman.territory].filter(Boolean).join(" · ") ||
          "No number or territory recorded"}
      </div>
      <div className="mt-1.5 text-[12px] text-body">
        {salesman.shopCount === 0
          ? "No shop names him yet"
          : `${salesman.shopCount} shop${salesman.shopCount === 1 ? "" : "s"} served through him`}
      </div>
    </div>
  );
}
