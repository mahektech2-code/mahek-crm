"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { money, shortDate } from "@/lib/format";
import { nextStage } from "@/lib/engines/lead-ladder";
import {
  salesTypeLabel,
  stageLabel,
  type LeadSalesType,
  type LeadStage,
} from "@/lib/lead-labels";
import { advanceLeadStage, setLeadNextAction } from "@/lib/actions/leads";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import type { HandoverCandidate } from "@/lib/services/lead-console-service";
import type { NegotiationRow } from "@/lib/services/lead-commercial-service";
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
import { LeadTabs } from "../lead-tabs";

/**
 * 16 — the negotiation desk.
 *
 * **This is the queue §G's refusal is protecting.** `handleOrder` refuses an
 * order against a lead below `negotiation` — the one refusal in the field
 * product that costs nothing, because an order nobody with the authority to
 * agree it has agreed is not a sale being thrown away. What that refusal
 * produces is this list: the conversations that have to be finished before
 * anybody may sell. A rule with no queue behind it is a rule nobody can work,
 * so the sentence is on the screen rather than in a comment.
 *
 * **What is blocking it is composed from facts, never stored.** There is no
 * negotiation table and there must not be one. Four things can block a
 * commercial conversation and every one of them is already recorded somewhere:
 * the credit days the customer asked for against the standard term, a
 * commitment nobody has asked for, a next action that is missing or has gone
 * past, and the reason on the newest transition. `blockersFor` is pure and
 * reads only what the row carries.
 *
 * **A missing transition is a different fact from a silent one.** A lead that
 * reached this rung before the ladder kept a record has no row at all; one
 * moved by somebody who typed nothing has a row with no reason. Drawing both
 * as a blank cell would make the first look like carelessness and hide that
 * the second is what it is.
 */
export function NegotiationScreen({
  workspace,
  rows,
  total,
  stalled,
  noCommitment,
  day,
  standardTermDays,
  reasonLabels,
  people,
  canWork,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  rows: NegotiationRow[];
  /** From SQL — a capped list says what it is a slice of. */
  total: number;
  stalled: number;
  noCommitment: number;
  day: string;
  /** `bills.defaultCreditDays` — the term a credit ask is measured against. */
  standardTermDays: number;
  reasonLabels: Record<string, string>;
  people: HandoverCandidate[];
  canWork: boolean;
}) {
  const [planning, setPlanning] = React.useState<NegotiationRow | null>(null);
  const [advancing, setAdvancing] = React.useState<NegotiationRow | null>(null);

  const refused = "Only somebody who works leads can do this.";

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />

      <ScreenHeader
        title="Negotiation desk"
        subtitle="Every lead standing on the negotiation rung, oldest first, with what is holding it up. §G refuses an order against a lead below this rung — so this is the queue that refusal is protecting, and a conversation nobody is having is one nobody can sell through."
        actions={
          <Link
            href={leadHref(workspace, "leads")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      <Banner
        tone="info"
        title="No order may be taken below this rung"
        body="§G says the requirement visit carries no price, service or quality promise, and an order is the most commercial commitment there is. handleOrder refuses one against a lead below negotiation and names the way forward. Nothing is lost by that refusal — the order was never agreed with anybody who could agree it — but every lead it stops is on this list."
      />

      {stalled ? (
        <Banner
          tone="warn"
          title={`${plural(stalled, "negotiation")} with nothing owed by anybody`}
          body="§24 — no action, or a day that has gone past with no outcome recorded. A negotiation with nobody holding it is how a live prospect sits for six weeks with everybody assuming somebody else has it."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "In negotiation", value: String(total) },
          {
            label: "Nobody holding it",
            value: String(stalled),
            tone: stalled ? "warn" : undefined,
          },
          {
            label: "No commitment asked for",
            value: String(noCommitment),
            tone: noCommitment ? "warn" : undefined,
          },
          {
            label: "Longest here",
            value: rows.length ? plural(rows[0]?.daysHere ?? 0, "day") : "—",
          },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title="Nothing in negotiation"
          body="No lead is standing on the negotiation rung. That is an empty queue rather than a missing one — leads reach here by passing §28's gates, and the desk fills as they do."
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the {rows.length} that have been here longest, of {total}.
            </p>
          ) : null}

          <Table
            minWidth={1420}
            head={
              <>
                <HeadCell width={240}>Lead</HeadCell>
                <HeadCell width={120}>Sales type</HeadCell>
                <HeadCell width={110}>Here</HeadCell>
                <HeadCell width={300}>What is blocking it</HeadCell>
                <HeadCell width={240}>Last move</HeadCell>
                <HeadCell width={190}>Next action</HeadCell>
                <HeadCell width={220}>&nbsp;</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => {
              const blockers = blockersFor(r, standardTermDays);
              const up = nextStage(r.stage, r.salesType);
              return (
                <Row key={r.customerId} striped={i % 2 === 1}>
                  <Cell truncate={240}>
                    <Link href={leadHref(workspace, `leads/${r.customerId}`)} className="no-underline">
                      {r.name}
                    </Link>
                    <span className="block truncate text-[12px] text-muted">
                      {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </Cell>
                  <Cell>{salesTypeLabel(r.salesType)}</Cell>
                  <Cell>
                    {plural(r.daysHere, "day")}
                    <span className="block text-[12px] text-muted">
                      {r.quietDays ? `${plural(r.quietDays, "day")} quiet` : "active today"}
                    </span>
                  </Cell>
                  <Cell truncate={300}>
                    {blockers.length === 0 ? (
                      <span className="text-muted">
                        Nothing recorded against it — it is waiting on the conversation
                      </span>
                    ) : (
                      <span className="block space-y-1">
                        {blockers.map((b) => (
                          <span key={b.key} className="flex items-baseline gap-2">
                            <Pill tone={b.tone}>{b.label}</Pill>
                            <span className="truncate text-[12px] text-muted">{b.detail}</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </Cell>
                  <Cell truncate={240}>
                    {/*
                      NULL IS THREE DIFFERENT ANSWERS HERE, and a blank cell
                      would be all of them at once: a lead with no transition
                      row reached this rung before the ladder kept a record; a
                      row with no reason is somebody who typed nothing; and a
                      note without a code is words without a category.
                    */}
                    {!r.hasTransition ? (
                      <span className="text-muted">
                        No transition recorded
                        <span className="block text-[12px]">
                          It reached this rung before the ladder kept one
                        </span>
                      </span>
                    ) : (
                      <>
                        <span className="block truncate text-body">
                          {r.transitionReasonCode
                            ? (reasonLabels[r.transitionReasonCode] ?? r.transitionReasonCode)
                            : "No reason given"}
                        </span>
                        <span className="block truncate text-[12px] text-muted">
                          {[
                            r.transitionAt ? shortDate(r.transitionAt) : null,
                            r.transitionActorName,
                            r.transitionNote,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </span>
                      </>
                    )}
                  </Cell>
                  <Cell truncate={190}>
                    {r.nextAction && r.nextActionDate ? (
                      <>
                        <span className="block truncate text-body">{r.nextAction}</span>
                        <span className="block text-[12px] text-muted">
                          {shortDate(r.nextActionDate)}
                          {r.nextActionOwnerName ? ` · ${r.nextActionOwnerName}` : ""}
                          {r.nextActionOverdueDays
                            ? ` · ${plural(r.nextActionOverdueDays, "day")} past`
                            : ""}
                        </span>
                      </>
                    ) : (
                      <Pill tone="danger">Nobody holding it</Pill>
                    )}
                  </Cell>
                  <Cell>
                    <span className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        disabled={!canWork}
                        title={canWork ? "§24 — the action, the day and the person" : refused}
                        onClick={() => setPlanning(r)}
                      >
                        Next action
                      </Button>
                      <Button
                        size="sm"
                        tone="primary"
                        disabled={!canWork || !up}
                        title={
                          !canWork
                            ? refused
                            : !up
                              ? "This lead is at the top of its own ladder."
                              : `Move it to ${stageLabel(up)} — §28's gate is asked on the server.`
                        }
                        onClick={() => setAdvancing(r)}
                      >
                        {up ? `To ${stageLabel(up)}` : "Top of ladder"}
                      </Button>
                    </span>
                  </Cell>
                </Row>
              );
            })}
          </Table>
        </>
      )}

      {/*
        Keyed on the row so the modal REMOUNTS with fresh initial state rather
        than an effect resetting it when the prop changes. The React Compiler
        rules are on and that is the house pattern; see ConfirmDialog.
      */}
      {planning ? (
        <NextActionModal
          key={planning.customerId}
          customerId={planning.customerId}
          subject={planning.name}
          day={day}
          people={people}
          onClose={() => setPlanning(null)}
        />
      ) : null}

      {advancing ? (
        <AdvanceStageModal
          key={advancing.customerId}
          customerId={advancing.customerId}
          name={advancing.name}
          stage={advancing.stage}
          salesType={advancing.salesType}
          hint={
            advancing.forecastDate
              ? `They said ${shortDate(advancing.forecastDate)}${
                  advancing.forecastValuePaise
                    ? `, about ${money(advancing.forecastValuePaise)} — a forecast`
                    : ""
                }.`
              : "Nobody has asked when they will place it."
          }
          onClose={() => setAdvancing(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- the blockers */

type Blocker = { key: string; label: string; detail: string; tone: "danger" | "warn" | "neutral" };

/**
 * What is holding this negotiation up, composed rather than stored.
 *
 * Pure, and deliberately small: four questions asked of columns that already
 * exist. The credit ask is the one that needs a second number — a customer
 * asking for 60 days when the standard term is 30 is a commercial decision
 * somebody has to make, and the gap is the thing worth seeing rather than
 * either figure alone. An ask at or inside the standard term is not a blocker
 * and is not drawn: a row of green facts is a specification sheet, and the one
 * line that matters gets read as furniture.
 */
export function blockersFor(r: NegotiationRow, standardTermDays: number): Blocker[] {
  const out: Blocker[] = [];

  if (r.creditDaysWanted != null && r.creditDaysWanted > standardTermDays) {
    out.push({
      key: "credit",
      label: `${r.creditDaysWanted} days wanted`,
      detail: `Standard term is ${standardTermDays}. This account stands at ${r.standingTermDays}.`,
      tone: "warn",
    });
  }

  if (!r.forecastDate) {
    out.push({
      key: "commitment",
      label: "No commitment",
      detail: "Nobody has asked when they will place it. That day is what the first-order gate reads.",
      tone: "warn",
    });
  }

  if (!r.nextAction || !r.nextActionDate) {
    out.push({
      key: "plan",
      label: "No next action",
      detail: "§24 — an active lead may not sit with nothing owed by anybody.",
      tone: "danger",
    });
  } else if (r.nextActionOverdueDays) {
    out.push({
      key: "overdue",
      label: `${r.nextActionOverdueDays} days past`,
      detail: `${r.nextAction} — the day came and went with no outcome recorded.`,
      tone: "danger",
    });
  }

  return out;
}

/* ---------------------------------------------------------------- the modals */

/**
 * §24's four answers, in one dialog — the action, the day, the person, and
 * what that person is expected to come back with.
 *
 * It lives here and is imported by the commitments screen rather than copied
 * into it. Two of these would be two sets of rules about what §24 demands, and
 * the half that drifts is always the half somebody is reading.
 *
 * The capability is checked in `setLeadNextAction`, on the server. The button
 * that opens this is disabled for anybody who does not hold it and carries a
 * title saying so — but a server action is a URL, and the disabled control is
 * the courtesy rather than the rule.
 */
export function NextActionModal({
  customerId,
  subject,
  day,
  people,
  onClose,
}: {
  customerId: string;
  subject: string;
  day: string;
  people: HandoverCandidate[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [action, setAction] = React.useState("");
  const [date, setDate] = React.useState(day);
  const [ownerId, setOwnerId] = React.useState(people[0]?.id ?? "");
  const [outcome, setOutcome] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setLeadNextAction(customerId, {
        action,
        date,
        ownerId,
        outcome: outcome.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    toast.push(result.message ?? "Recorded.");
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title="Set the next action" width={520}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{subject}</div>
        <div className="text-muted">
          A date alone is how a lead sits for six weeks with everybody assuming somebody else
          has it. Four answers, not one.
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-ink">The action</span>
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          autoFocus
          className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
        />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-4">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">The day</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Who owes it</span>
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className="h-9 w-full rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[12px] text-muted">
            Somebody who can sign in and see it. That is checked on the server too.
          </span>
        </label>
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">
          What they should come back with (optional)
        </span>
        <input
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
        />
      </label>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || !action.trim() || !date || !ownerId}
          title={
            !action.trim()
              ? "Name the action. A date with nothing against it is what this rule exists to stop."
              : !ownerId
                ? "Somebody has to owe it."
                : undefined
          }
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Record it"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Moving a lead one rung up its own ladder.
 *
 * Exported and taken by the first-orders screen too: the same act, the same
 * refusal, and one dialog rather than two that would each render §28's missing
 * conditions slightly differently.
 *
 * THE GATE IS NOT ASKED HERE. §28 lives in `lead-gates.ts` and
 * `advanceLeadStage` asks it on the server before it writes — so what this
 * dialog does is send the move and render the refusal, conditions and all,
 * where the person can read what is still missing. A copy of the gate typed
 * into this screen would drift inside one release, and the half that drifts is
 * the half somebody is reading at the moment of the refusal.
 */
export function AdvanceStageModal({
  customerId,
  name,
  stage,
  salesType,
  hint,
  onClose,
}: {
  customerId: string;
  name: string;
  stage: LeadStage;
  salesType: LeadSalesType | null;
  /** One line of context above the note box — what this lead has promised. */
  hint: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const to = nextStage(stage, salesType);

  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (!to) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await advanceLeadStage({
        customerId,
        to,
        note: note.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    toast.push(result.message ?? "Moved.");
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={to ? `Move to ${stageLabel(to)}` : "Nowhere to move"} width={480}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{name}</div>
        <div className="text-muted">{hint}</div>
      </div>

      <p className="mb-3 text-[13px] text-muted">
        §28 decides whether this rung may be entered, and it is asked on the server. If
        anything is still missing the refusal below says exactly what.
      </p>

      <label className="block">
        <span className="mb-1 block text-[13px] font-medium text-ink">Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
        />
      </label>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || !to}
          title={!to ? "This lead is at the top of its own ladder." : undefined}
          onClick={() => void submit()}
        >
          {busy ? "Moving…" : "Move it"}
        </Button>
      </div>
    </Modal>
  );
}
