"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { shortDate, stamp } from "@/lib/format";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import { advanceLeadStage, saveLeadQualification } from "@/lib/actions/leads";
import type {
  ChecklistItem,
  OverriddenMoveRow,
  QualificationDeskRow,
} from "@/lib/services/lead-qualify-service";
import {
  Banner,
  Button,
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../../../parts";
import { plural } from "../../../words";

type Coded = { code: string; label: string };

/**
 * §28, as a desk.
 *
 * **NOTHING HERE DECIDES ANYTHING.** Every verdict on this screen — whether a
 * gate is open, what it is waiting on, which conditions the tick answers — came
 * from `gateForNext` and `checklistFor` by way of the service. This file draws
 * them. That is not tidiness: the handset draws the next rung disabled from
 * those same two functions and `advanceLeadStage` refuses on them before it
 * writes, so a screen that worked any of it out for itself would be a third
 * opinion drifting from two, and the screen is the half somebody is working
 * from.
 *
 * **A TICK IS NOT AN ANSWER WHERE A COLUMN EXISTS**, and the whole reason this
 * screen is worth building is that the wrong state was previously invisible. A
 * ticked box beside an empty field satisfies nobody: the gate goes on refusing,
 * the salesman goes on believing he has done it, and no screen anywhere said
 * which. It is drawn in its own colour, counted on the row, and banner-ed at
 * the top.
 */
export function ChecklistScreen({
  rows,
  total,
  capped,
  overrides,
  overrideTotal,
  byCondition,
  overrideDays,
  view,
  overrideOffered,
  overrideReasons,
  canWork,
  canOverride,
}: {
  rows: QualificationDeskRow[];
  /** From SQL — a capped desk still says what it is a slice of. */
  total: number;
  capped: boolean;
  overrides: OverriddenMoveRow[];
  overrideTotal: number;
  byCondition: Array<{ id: string; count: number }>;
  overrideDays: number;
  view: "all" | "blocked" | "ready" | "overridden";
  overrideOffered: boolean;
  overrideReasons: Coded[];
  canWork: boolean;
  canOverride: boolean;
}) {
  const [ticking, setTicking] = React.useState<QualificationDeskRow | null>(null);
  const [advancing, setAdvancing] = React.useState<QualificationDeskRow | null>(null);

  const blocked = rows.filter((r) => !r.ready);
  const ready = rows.filter((r) => r.ready);
  const wrongState = rows.filter((r) => r.tickedButEmpty > 0);

  const shown = view === "blocked" ? blocked : view === "ready" ? ready : rows;
  const base = "/sales/leads/qualify/checklist";

  return (
    <>
      <ScreenHeader
        title="Qualification checklists"
        subtitle="No lead moves forward because somebody pressed a button. This is what each one at Qualification still owes — the same conditions the handset draws and the same ones the save refuses on, said as a list of what to go and do."
        actions={
          <Link
            href="/sales/leads"
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← All leads
          </Link>
        }
      />

      <FilterChips
        current={view}
        options={[
          { key: "all", label: "In qualification", href: base, count: rows.length },
          { key: "blocked", label: "Blocked", href: `${base}?view=blocked`, count: blocked.length },
          { key: "ready", label: "Ready to advance", href: `${base}?view=ready`, count: ready.length },
          {
            key: "overridden",
            label: "Overridden",
            href: `${base}?view=overridden`,
            count: overrideTotal,
          },
        ]}
      />

      {view !== "overridden" && wrongState.length ? (
        <Banner
          tone="danger"
          title={`${plural(wrongState.length, "lead")} with a ticked box over an empty field`}
          body="Eight of the twelve are answered by a real value and not by the checkbox beside them — the gate reads the litres, not a tick saying somebody asked about them. A ticked box with nothing behind it is the exact state §28 exists to prevent, and until now nothing drew it."
        />
      ) : null}

      {view === "overridden" ? (
        <OverriddenView
          rows={overrides}
          total={overrideTotal}
          byCondition={byCondition}
          days={overrideDays}
        />
      ) : (
        <>
          <MetricRow
            metrics={[
              { label: "At qualification", value: String(total) },
              {
                label: "Blocked",
                value: String(blocked.length),
                tone: blocked.length ? "warn" : undefined,
              },
              {
                label: "Ready",
                value: String(ready.length),
                tone: ready.length ? "success" : undefined,
              },
              {
                label: "Ticked but empty",
                value: String(wrongState.reduce((n, r) => n + r.tickedButEmpty, 0)),
                tone: wrongState.length ? "danger" : undefined,
              },
            ]}
          />

          {shown.length === 0 ? (
            <Empty
              title={
                view === "blocked"
                  ? "Nothing is stuck behind a gate"
                  : view === "ready"
                    ? "Nothing is waiting to be moved on"
                    : "No lead is at Qualification"
              }
              body={
                view === "blocked"
                  ? "A good day, and worth being able to see. Every lead in qualification has its answers in, which means the next step on each of them is somebody's to take rather than something to chase."
                  : view === "ready"
                    ? "Every lead here still owes something. The Blocked view says what, in words, per lead."
                    : "A lead reaches Qualification once its sales manager has verified it. The Verification queue is where that call is waiting."
              }
            />
          ) : (
            <>
              {capped ? (
                <p className="mb-2 text-[12px] text-muted">
                  Showing the {rows.length} longest at this rung of {total}. Each row is read
                  through the same gate the save uses, which costs a handful of queries per lead —
                  so this is capped deliberately rather than paged into a screen that takes ten
                  seconds to draw.
                </p>
              ) : null}
              <Table
                minWidth={1320}
                head={
                  <>
                    <HeadCell width={230}>Lead</HeadCell>
                    <HeadCell width={140}>Sales type</HeadCell>
                    <HeadCell width={150}>Salesman</HeadCell>
                    <HeadCell width={130}>On this rung</HeadCell>
                    <HeadCell width={170}>Checklist</HeadCell>
                    <HeadCell width={320}>Stuck behind</HeadCell>
                    <HeadCell align="right" width={180} />
                  </>
                }
              >
                {shown.map((r, i) => (
                  <Row key={r.customerId} striped={i % 2 === 1}>
                    <Cell truncate={230}>
                      <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
                        {r.name}
                      </Link>
                      <span className="block truncate text-[12px] text-muted">
                        {[r.companyName, r.city].filter(Boolean).join(" · ") || r.mobile || "—"}
                      </span>
                    </Cell>
                    <Cell>
                      {salesTypeLabel(r.salesType)}
                      <span className="block text-[12px] text-muted">
                        {r.gate.noNextRung ? "top of the ladder" : `next: ${stageLabel(r.gate.to)}`}
                      </span>
                    </Cell>
                    <Cell truncate={150}>
                      {r.salesmanId ? (
                        <Link href={`/sales/people/${r.salesmanId}`} className="no-underline">
                          {r.salesmanName}
                        </Link>
                      ) : (
                        <span className="text-warn-ink">Nobody</span>
                      )}
                    </Cell>
                    <Cell>
                      {plural(r.stuckDays, "day")}
                      <span className="block text-[12px] text-muted">
                        {r.stageSince ? `since ${shortDate(r.stageSince)}` : "no date recorded"}
                      </span>
                    </Cell>
                    <Cell>
                      <span className="tabular-nums">
                        {r.done} / {r.checklist.length}
                      </span>
                      {r.tickedButEmpty ? (
                        <span className="ml-1.5">
                          <Pill tone="danger">{r.tickedButEmpty} ticked, empty</Pill>
                        </span>
                      ) : null}
                      <span className="block text-[12px] text-muted">
                        {r.ready ? "gate open" : plural(r.gate.missing.length, "condition")}
                      </span>
                    </Cell>
                    <Cell truncate={320}>
                      {r.ready ? (
                        <span className="text-[13px] text-success">
                          Nothing — it can go to {stageLabel(r.gate.to)}
                        </span>
                      ) : (
                        <span
                          className="block truncate text-[13px] text-body"
                          title={r.gate.missing.map((c) => c.says).join(" · ")}
                        >
                          {r.gate.missing.map((c) => c.says).join(" · ")}
                        </span>
                      )}
                    </Cell>
                    <Cell align="right">
                      <span className="inline-flex gap-2">
                        <Button
                          size="sm"
                          disabled={!canWork}
                          title={
                            canWork
                              ? undefined
                              : "Working a lead is `lead.work`. None of your hats carries it."
                          }
                          onClick={() => setTicking(r)}
                        >
                          Checklist
                        </Button>
                        <Button
                          size="sm"
                          tone={r.ready ? "primary" : "default"}
                          disabled={!canWork || r.gate.noNextRung}
                          title={
                            r.gate.noNextRung
                              ? "There is no rung above this one on this lead's ladder."
                              : canWork
                                ? undefined
                                : "Moving a lead is `lead.work`. None of your hats carries it."
                          }
                          onClick={() => setAdvancing(r)}
                        >
                          Advance
                        </Button>
                      </span>
                    </Cell>
                  </Row>
                ))}
              </Table>
            </>
          )}
        </>
      )}

      {/* Keyed on the lead, so opening a different one REMOUNTS with its own
          answers rather than an effect clearing the last lead's — the React
          Compiler rules are on and a reset-in-effect is what they forbid. */}
      {ticking ? (
        <ChecklistModal key={ticking.customerId} row={ticking} onClose={() => setTicking(null)} />
      ) : null}
      {advancing ? (
        <AdvanceModal
          key={advancing.customerId}
          row={advancing}
          overrideOffered={overrideOffered}
          overrideReasons={overrideReasons}
          canOverride={canOverride}
          onClose={() => setAdvancing(null)}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- the checklist */

/**
 * The twelve (or thirty), with each one saying what actually answers it.
 *
 * The box is offered only where the box is the answer. Where a column decides
 * it, the row says which record holds it and links to the lead, because a
 * checkbox that cannot satisfy its own condition is a control that teaches
 * somebody the checklist is broken — and ticking it is how the ticked-but-empty
 * state is created in the first place.
 */
function ChecklistModal({
  row,
  onClose,
}: {
  row: QualificationDeskRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [answers, setAnswers] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(row.checklist.map((c) => [c.id, c.ticked])),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const changed = row.checklist.filter((c) => (answers[c.id] ?? false) !== c.ticked);

  async function save() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await saveLeadQualification(
        row.customerId,
        Object.fromEntries(changed.map((c) => [c.id, answers[c.id] ?? false])),
      );
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  const byValue = row.checklist.filter((c) => !c.satisfiedByTick);

  return (
    <Modal open onClose={onClose} title="Qualification checklist" width={720}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{row.name}</div>
        <div className="text-muted">
          {[row.companyName, row.city].filter(Boolean).join(" · ") || row.mobile || "—"} ·{" "}
          {salesTypeLabel(row.salesType)} · {plural(row.stuckDays, "day")} at{" "}
          {stageLabel(row.stage)}
        </div>
      </div>

      <p className="mb-3 text-[12px] text-pretty text-muted">
        {byValue.length} of these {row.checklist.length} are answered by a real value on the
        record and not by a box here — the gate reads what is stored. A tick beside an empty field
        satisfies nothing, which is why those rows carry no checkbox and say where the answer
        lives instead.
      </p>

      <div className="max-h-[52vh] overflow-y-auto rounded-[6px] border border-line">
        {row.checklist.map((c) => (
          <ConditionRow
            key={c.id}
            item={c}
            checked={answers[c.id] ?? false}
            customerId={row.customerId}
            onToggle={(v) => setAnswers((a) => ({ ...a, [c.id]: v }))}
          />
        ))}
      </div>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted">
          {changed.length ? plural(changed.length, "change") : "Nothing changed yet"}
        </span>
        <div className="flex gap-2">
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy || changed.length === 0}
            title={changed.length === 0 ? "Nothing has been changed." : undefined}
            onClick={save}
          >
            {busy ? "Saving…" : "Save the answers"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ConditionRow({
  item,
  checked,
  customerId,
  onToggle,
}: {
  item: ChecklistItem;
  checked: boolean;
  customerId: string;
  onToggle: (value: boolean) => void;
}) {
  return (
    <div
      className={
        item.tickedButEmpty
          ? "flex items-start gap-3 border-b border-divider bg-danger-soft px-3 py-2.5 last:border-b-0"
          : "flex items-start gap-3 border-b border-divider px-3 py-2.5 last:border-b-0"
      }
    >
      <div className="mt-0.5 w-5 flex-none">
        {item.satisfiedByTick ? (
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={item.says}
            className="h-4 w-4 cursor-pointer"
          />
        ) : (
          <span
            className={item.met ? "text-success" : "text-muted"}
            title="Answered by a value on the record, not by a box here."
          >
            {item.met ? "✓" : "○"}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{item.says}</div>
        <div className="text-[12px] text-muted">
          {item.satisfiedByTick ? (
            "A judgement — the tick is the answer."
          ) : item.met ? (
            "Answered on the record."
          ) : (
            <>
              Needs a value on the record —{" "}
              <Link href={`/sales/leads/${customerId}`} className="no-underline">
                open the lead
              </Link>
              .
            </>
          )}
          {item.group ? ` · ${item.group}` : ""}
        </div>
        {item.tickedButEmpty ? (
          <div className="mt-1 text-[12px] font-medium text-danger">
            Ticked, and the field behind it is still empty. The gate goes on refusing this one,
            whatever the box says.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- advancing */

/**
 * M-01 and M-10 in one dialog, because they are one decision read two ways.
 *
 * Where the gate is open, this moves the lead. Where it is shut, it says what
 * is missing and — only for a manager, only where the setting allows it —
 * offers to pass it anyway with a coded reason. The override exists so the rule
 * survives contact with a Tuesday: a system that refuses everything is defeated
 * in a week by people recording the work after the event, and the record then
 * says the process was followed when it was not, which is worse than the gate
 * being open.
 */
function AdvanceModal({
  row,
  overrideOffered,
  overrideReasons,
  canOverride,
  onClose,
}: {
  row: QualificationDeskRow;
  overrideOffered: boolean;
  overrideReasons: Coded[];
  canOverride: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [overriding, setOverriding] = React.useState(false);
  const [reasonCode, setReasonCode] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [missing, setMissing] = React.useState(row.gate.missing);

  const canPass = overrideOffered && canOverride;

  async function move() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await advanceLeadStage({
        customerId: row.customerId,
        to: row.gate.to,
        override: overriding ? { reasonCode, note: note.trim() || undefined } : undefined,
      });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      /* The action's own reading of the gate, which is a moment fresher than
         the one this page was drawn with. Somebody may have filled a field in
         since, or emptied one. */
      if (result.fieldErrors?.length) {
        setMissing(result.fieldErrors.map((f) => ({ id: f.field, says: f.message })));
      }
      return;
    }
    onClose();
    toast.push(result.message ?? "Moved.");
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={`Move to ${stageLabel(row.gate.to)}`} width={560}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{row.name}</div>
        <div className="text-muted">
          {[row.companyName, row.city].filter(Boolean).join(" · ") || row.mobile || "—"} ·{" "}
          {stageLabel(row.stage)} → {stageLabel(row.gate.to)}
        </div>
      </div>

      {missing.length === 0 ? (
        <p className="text-[13px] text-body">
          The gate is open: every condition this rung asks for is answered. Moving it writes a
          transition row, which is append-only — a move recorded wrongly is corrected by a further
          move, never by an edit.
        </p>
      ) : (
        <div className="rounded-[6px] border border-line bg-canvas px-3 py-2.5">
          <div className="text-[13px] font-medium text-ink">
            {plural(missing.length, "thing")} still to do
          </div>
          <ul className="mt-1 list-disc pl-5 text-[13px] text-body">
            {missing.map((c) => (
              <li key={c.id}>{c.says}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] text-muted">
            The gate engine&rsquo;s own list, said as instructions rather than as faults: it is
            what to go and do, not a complaint about work already done.
          </p>
        </div>
      )}

      {missing.length > 0 ? (
        <div className="mt-3">
          {!canPass ? (
            <p className="text-[12px] text-muted">
              {!overrideOffered
                ? "Passing a gate that is shut has been switched off for this deployment, so the conditions have to be met."
                : "Only a manager holding `lead.override` may pass a gate that is shut."}
            </p>
          ) : !overriding ? (
            <Button tone="default" onClick={() => setOverriding(true)}>
              Move it anyway, with a reason
            </Button>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-[13px] font-medium text-ink">
                  Why is this being passed?
                </span>
                <select
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value)}
                  className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
                >
                  <option value="">Pick one…</option>
                  {overrideReasons.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mt-3 block">
                <span className="mb-1 block text-[13px] font-medium text-ink">
                  Anything to add (optional)
                </span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
                />
              </label>
              <p className="mt-1.5 text-[12px] text-muted">
                Exactly what was still missing is stored on the transition. Not as a record of who
                cut a corner — it is how somebody finds out that one condition is shut on
                everybody and is the wrong condition.
              </p>
            </>
          )}
        </div>
      ) : null}

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || (missing.length > 0 && (!overriding || !reasonCode))}
          title={
            missing.length > 0 && !overriding
              ? "The gate is shut. Either the conditions are met, or it is passed with a reason."
              : missing.length > 0 && !reasonCode
                ? "An override has to say why."
                : undefined
          }
          onClick={move}
        >
          {busy
            ? "Saving…"
            : missing.length > 0
              ? `Pass the gate and move to ${stageLabel(row.gate.to)}`
              : `Move to ${stageLabel(row.gate.to)}`}
        </Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- the overrides */

/**
 * Who passed a shut gate, on what, and why.
 *
 * **NOT A SHAMING LIST.** `byCondition` is drawn first and it is the point of
 * the view: a condition forty leads were pushed past is a condition asking for
 * something the business does not actually have, and the fix is the gate rather
 * than the forty. One override on one lead is a Tuesday; the same one on every
 * lead is a rule that needs changing.
 */
function OverriddenView({
  rows,
  total,
  byCondition,
  days,
}: {
  rows: OverriddenMoveRow[];
  total: number;
  byCondition: Array<{ id: string; count: number }>;
  days: number;
}) {
  return (
    <>
      <MetricRow
        metrics={[
          { label: `Overrides in ${days} days`, value: String(total) },
          { label: "Conditions passed", value: String(byCondition.length) },
          {
            label: "Most passed",
            value: byCondition[0] ? String(byCondition[0].count) : "—",
            sub: byCondition[0]?.id,
          },
        ]}
      />

      {byCondition.length ? (
        <div className="mb-4 rounded-[6px] border border-line bg-surface px-4 py-3">
          <div className="text-sm font-medium text-ink">What is being passed, and how often</div>
          <p className="mt-0.5 mb-2 text-[12px] text-pretty text-muted">
            A condition near the top of this list is one to read twice. It is either the hardest
            honest thing we ask a salesman for, or it is asking for something this business does
            not have — and the second is a fix to the gate rather than to the people.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {byCondition.map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1.5 rounded-[4px] border border-line bg-canvas px-2 py-1 text-[12px] text-body"
              >
                <span className="font-medium">{c.id}</span>
                <span className="tabular-nums text-muted">{c.count}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Empty
          title="Nobody has passed a shut gate"
          body={`In the last ${days} days every lead that moved met its conditions. That is worth knowing either way: an override is allowed on purpose, and a book with none of them is a book where the gates are asking for things people can actually give.`}
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the newest {rows.length} of {total}.
            </p>
          ) : null}
          <Table
            minWidth={1280}
            head={
              <>
                <HeadCell width={230}>Lead</HeadCell>
                <HeadCell width={190}>Move</HeadCell>
                <HeadCell width={170}>Who, and in which hat</HeadCell>
                <HeadCell width={150}>When</HeadCell>
                <HeadCell width={180}>Reason</HeadCell>
                <HeadCell width={320}>What was still missing</HeadCell>
              </>
            }
          >
            {rows.map((r, i) => (
              <Row key={r.id} striped={i % 2 === 1}>
                <Cell truncate={230}>
                  <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
                    {r.customerName}
                  </Link>
                  <span className="block truncate text-[12px] text-muted">
                    {[r.companyName, r.city].filter(Boolean).join(" · ") || "—"}
                  </span>
                </Cell>
                <Cell>
                  {r.fromStage ? stageLabel(r.fromStage) : "—"} → {stageLabel(r.toStage)}
                  <span className="block text-[12px] text-muted">
                    {salesTypeLabel(r.salesType)}
                  </span>
                </Cell>
                <Cell truncate={170}>
                  {r.actorName ?? "account since removed"}
                  <span className="block truncate text-[12px] text-muted">
                    {[r.actorRole, r.actorApp].filter(Boolean).join(" · ") || "hat not recorded"}
                  </span>
                </Cell>
                <Cell title={stamp(r.at)}>{shortDate(r.at)}</Cell>
                <Cell truncate={180}>
                  {r.reasonCode ?? "—"}
                  {r.note ? (
                    <span className="block truncate text-[12px] text-muted" title={r.note}>
                      {r.note}
                    </span>
                  ) : null}
                </Cell>
                <Cell truncate={320}>
                  {r.overriddenConditions.length ? (
                    <span
                      className="block truncate text-[13px] text-body"
                      title={r.overriddenConditions.join(" · ")}
                    >
                      {r.overriddenConditions.join(" · ")}
                    </span>
                  ) : (
                    <span className="text-[12px] text-muted">
                      nothing recorded — this row predates the column
                    </span>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}
    </>
  );
}
