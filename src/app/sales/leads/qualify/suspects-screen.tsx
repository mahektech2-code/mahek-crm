"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { money, shortDate, stamp } from "@/lib/format";
import { salesTypeLabel, stageLabel } from "@/lib/lead-labels";
import { decideSuspect, keepAsSuspect } from "@/lib/actions/leads";
import type { SuspectDecisionRow } from "@/lib/services/lead-qualify-service";
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
} from "../../parts";
import { plural } from "../../words";

type Coded = { code: string; label: string };

/**
 * §4 — who nobody has decided about, and how far past the cap they are.
 *
 * **THREE STATES DRAWN AS THREE.** Warned is the first threshold reached and
 * costs nothing; must-decide is the cap, where the handset will not let the
 * visit be CLOSED without an answer; past it is where the manager has already
 * been notified and the lead is now somebody's to settle at a desk. They read
 * as three because they ARE three: a salesman on his second visit needs a
 * nudge, and a shop visited five times that nobody has ruled on is a different
 * conversation entirely.
 *
 * **Nothing here refuses anything.** There is no control on this screen that
 * stops a visit, and there must never be one. The engine's `mustDecideSuspect`
 * is what says an answer is owed; everything past that is asking.
 *
 * **Promoting to Prospect is itself gated, and the refusal is drawn in full.**
 * §6's eight answers have to be in before a Suspect may be a Prospect, so
 * "Prospect" here can come back with a list of what is still missing. That list
 * is the action's own — from the gate engine, through `advanceLeadStage` — and
 * it is rendered as instructions rather than as an error, because it is a list
 * of what to go and do.
 */
export function SuspectsScreen({
  rows,
  total,
  warnAt,
  decideAt,
  band,
  prospectReasons,
  lostReasons,
  canWork,
}: {
  rows: SuspectDecisionRow[];
  /** From SQL — a capped list still says what it is a slice of. */
  total: number;
  warnAt: number;
  decideAt: number;
  band: "all" | "warned" | "must" | "past";
  prospectReasons: Coded[];
  lostReasons: Coded[];
  canWork: boolean;
}) {
  const [deciding, setDeciding] = React.useState<SuspectDecisionRow | null>(null);

  const past = rows.filter((r) => r.band === "past");
  const must = rows.filter((r) => r.band === "must_decide");
  const warned = rows.filter((r) => r.band === "warned");
  const legacy = rows.filter((r) => r.legacyRung);

  const shown =
    band === "past" ? past : band === "must" ? must : band === "warned" ? warned : rows;

  const base = "/sales/leads/qualify";

  return (
    <>
      <ScreenHeader
        title="Suspect decisions"
        subtitle={`A Suspect cannot be visited for ever. The cap asks for an answer — Prospect or not — and it never refuses the visit: a salesman whose visit is blocked stops recording visits, and we would lose the GPS, the competitor note and the reason in order to stop a number reaching ${decideAt + 1}.`}
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
        current={band}
        options={[
          { key: "all", label: "Everybody undecided", href: base, count: rows.length },
          {
            key: "warned",
            label: `Warned (${warnAt} visits)`,
            href: `${base}?band=warned`,
            count: warned.length,
          },
          {
            key: "must",
            label: `Must decide (${decideAt})`,
            href: `${base}?band=must`,
            count: must.length,
          },
          { key: "past", label: "Past it", href: `${base}?band=past`, count: past.length },
        ]}
      />

      {past.length ? (
        <Banner
          tone="danger"
          title={`${plural(past.length, "lead")} past the cap of ${decideAt}`}
          body="Their managers have been notified. Nothing stopped the visits being made, and nothing should have — what is outstanding is the answer, and it is now quicker to settle these at a desk than to wait for another visit."
        />
      ) : null}

      {legacy.length ? (
        <Banner
          tone="info"
          title={`${plural(legacy.length, "lead")} on the rungs this product shipped with`}
          body="These carry no sales type, so they climb new → contacted → qualified and the funnel's cap does not answer for them. They are listed because a shop nobody has decided about is the same problem whichever vocabulary it was raised in — and they are marked, rather than being shown as though a rule is being broken."
        />
      ) : null}

      <MetricRow
        metrics={[
          { label: "Undecided", value: String(total) },
          { label: `Warned at ${warnAt}`, value: String(warned.length), tone: warned.length ? "warn" : undefined },
          {
            label: `Must decide at ${decideAt}`,
            value: String(must.length),
            tone: must.length ? "warn" : undefined,
          },
          { label: "Past it", value: String(past.length), tone: past.length ? "danger" : undefined },
        ]}
      />

      {shown.length === 0 ? (
        <Empty
          title="Nobody is sitting undecided"
          body={`A salesman is warned on visit ${warnAt} and owes an answer on visit ${decideAt}. An empty list means every Suspect anybody has been back to has been ruled on one way or the other, which is the whole point of the cap.`}
        />
      ) : (
        <>
          {rows.length < total ? (
            <p className="mb-2 text-[12px] text-muted">
              Showing the {rows.length} most visited of {total}. The band counts above describe
              these {rows.length}; the figure beside &ldquo;Undecided&rdquo; is the whole book.
            </p>
          ) : null}
          <Table
            minWidth={1240}
            head={
              <>
                <HeadCell width={240}>Suspect</HeadCell>
                <HeadCell width={150}>Rung</HeadCell>
                <HeadCell width={160}>Salesman</HeadCell>
                <HeadCell width={170}>Visits</HeadCell>
                <HeadCell width={130}>Undecided</HeadCell>
                <HeadCell width={230}>What we know</HeadCell>
                <HeadCell align="right" width={160} />
              </>
            }
          >
            {shown.map((r, i) => (
              <Row key={r.customerId} striped={i % 2 === 1}>
                <Cell truncate={240}>
                  <Link href={`/sales/leads/${r.customerId}`} className="no-underline">
                    {r.name}
                  </Link>
                  <span className="block truncate text-[12px] text-muted">
                    {[r.companyName, r.city].filter(Boolean).join(" · ") || r.mobile || "—"}
                  </span>
                </Cell>
                <Cell>
                  {stageLabel(r.stage)}
                  <span className="block text-[12px] text-muted">
                    {r.legacyRung ? "legacy ladder" : salesTypeLabel(r.salesType)}
                  </span>
                </Cell>
                <Cell truncate={160}>
                  {r.salesmanId ? (
                    <Link href={`/sales/people/${r.salesmanId}`} className="no-underline">
                      {r.salesmanName}
                    </Link>
                  ) : (
                    <span className="text-warn-ink">Nobody</span>
                  )}
                </Cell>
                <Cell>
                  <span className="tabular-nums">{plural(r.visitCount, "visit")}</span>
                  <span className="ml-1.5">
                    <BandPill row={r} decideAt={decideAt} />
                  </span>
                  <span className="block text-[12px] text-muted">
                    {r.lastVisitAt ? `last ${shortDate(r.lastVisitAt)}` : "no check-in recorded"}
                  </span>
                </Cell>
                <Cell>
                  {plural(r.waitingDays, "day")}
                  {r.stageSince ? (
                    <span className="block text-[12px] text-muted">
                      since {shortDate(r.stageSince)}
                    </span>
                  ) : null}
                </Cell>
                <Cell truncate={230}>
                  <span className="block truncate text-[13px] text-body">
                    {r.competitor ? `Using ${r.competitor}` : "Competitor not established"}
                  </span>
                  <span className="block truncate text-[12px] text-muted">
                    {r.monthlyLitres ? `${r.monthlyLitres} L a month` : "no volume"}
                    {r.potentialPaise ? ` · ${money(r.potentialPaise)}` : ""}
                    {r.holdReason ? ` · held: ${r.holdReason}` : ""}
                  </span>
                </Cell>
                <Cell align="right">
                  <Button
                    size="sm"
                    tone={r.demanded ? "primary" : "default"}
                    disabled={!canWork}
                    title={
                      canWork
                        ? undefined
                        : "Working a lead is `lead.work`. None of your hats carries it."
                    }
                    onClick={() => setDeciding(r)}
                  >
                    Decide
                  </Button>
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}

      {/* Keyed on the row, so picking a different Suspect REMOUNTS the form with
          fresh answers rather than an effect clearing them — the React Compiler
          rules are on and a reset-in-effect is what they forbid. */}
      {deciding ? (
        <DecisionModal
          key={deciding.customerId}
          row={deciding}
          decideAt={decideAt}
          prospectReasons={prospectReasons}
          lostReasons={lostReasons}
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </>
  );
}

/** The band, said in a word. Three states, three pills, no fourth meaning. */
function BandPill({ row, decideAt }: { row: SuspectDecisionRow; decideAt: number }) {
  if (row.band === "past") {
    return <Pill tone="danger">{row.overCap > 0 ? `${row.overCap} over` : "Past it"}</Pill>;
  }
  if (row.band === "must_decide") return <Pill tone="danger">Must decide</Pill>;
  if (row.band === "warned") return <Pill tone="warn">Warned</Pill>;
  return (
    <span
      className="text-[12px] text-muted"
      title={`Nothing is owed yet. An answer becomes mandatory on visit ${decideAt}.`}
    >
      watching
    </span>
  );
}

/**
 * §4's one question, with its three answers.
 *
 * The third is the one that asks WHY. "Still a Suspect" is a legitimate answer
 * — a shop that genuinely needs another look — and the whole reason §4 demands
 * something rather than refusing something is that this answer exists. It has
 * to say why, for the same reason a loss and an On Hold do: the next visit goes
 * exactly the same otherwise.
 */
function DecisionModal({
  row,
  decideAt,
  prospectReasons,
  lostReasons,
  onClose,
}: {
  row: SuspectDecisionRow;
  decideAt: number;
  prospectReasons: Coded[];
  lostReasons: Coded[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [answer, setAnswer] = React.useState<"prospect" | "not" | "still" | null>(null);
  const [reasonCode, setReasonCode] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [missing, setMissing] = React.useState<{ field: string; message: string }[]>([]);

  const reasons = answer === "prospect" ? prospectReasons : answer === "not" ? lostReasons : [];

  async function submit() {
    if (answer !== "prospect" && answer !== "not" && answer !== "still") return;
    setBusy(true);
    setError(null);
    setMissing([]);
    let result;
    try {
      /*
       * Two actions, because they are two different acts. The first two answers
       * MOVE the lead and go through the gate; the third does not move it at
       * all — it records why it is staying where it is, which is what keeps it
       * on this queue rather than taking it off one.
       */
      result =
        answer === "still"
          ? await keepAsSuspect(row.customerId, note.trim())
          : await decideSuspect(row.customerId, {
              prospect: answer === "prospect",
              reasonCode,
              note: note.trim() || undefined,
            });
    } finally {
      /* Cleared whatever happened. An action that rejects rather than returning
         a Result would otherwise leave the button dead until a reload. */
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      setMissing(result.fieldErrors ?? []);
      return;
    }
    onClose();
    toast.push(result.message ?? "Decision recorded.");
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title="Prospect, or not a Prospect" width={560}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{row.name}</div>
        <div className="text-muted">
          {[row.companyName, row.city].filter(Boolean).join(" · ") || row.mobile || "—"}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
          <span>
            Visits: <span className="text-body">{row.visitCount}</span> of {decideAt}
          </span>
          {row.lastVisitAt ? (
            <span>
              Last: <span className="text-body">{stamp(row.lastVisitAt)}</span>
            </span>
          ) : null}
          {row.competitor ? (
            <span>
              Using: <span className="text-body">{row.competitor}</span>
            </span>
          ) : null}
          {row.monthlyLitres ? (
            <span>
              A month: <span className="text-body">{row.monthlyLitres} L</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="mb-1 text-[13px] font-medium text-ink">Your answer</div>
      <div className="flex flex-wrap gap-2">
        <Answer
          on={answer === "prospect"}
          label="Prospect"
          hint="Worth pursuing — say which of §5's reasons"
          onPick={() => {
            setAnswer("prospect");
            setReasonCode("");
            setError(null);
            setMissing([]);
          }}
        />
        <Answer
          on={answer === "not"}
          label="Not a Prospect"
          hint="Close it, with the reason recorded"
          onPick={() => {
            setAnswer("not");
            setReasonCode("");
            setError(null);
            setMissing([]);
          }}
        />
        <Answer
          on={answer === "still"}
          label="Still a Suspect"
          hint="Keep it, and say why it needs another look"
          onPick={() => {
            setAnswer("still");
            setReasonCode("");
            setError(null);
            setMissing([]);
          }}
        />
      </div>

      {answer === "prospect" || answer === "not" ? (
        <div className="mt-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              {answer === "prospect" ? "Why is this worth pursuing?" : "Why is it closed?"}
            </span>
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
            >
              <option value="">Pick one…</option>
              {reasons.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[12px] text-muted">
            A code rather than a sentence, so &ldquo;how many did we lose on credit terms this
            quarter&rdquo; is a question somebody can ask.
          </p>
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
        </div>
      ) : null}

      {/*
        THE THIRD ANSWER, which used to be a named gap here.
        Keeping a lead a Suspect asks WHY, and the reason belongs in
        `lead_hold_reason` — the same column that answers "why is this parked",
        because it is the same question at two different rungs. It was writable
        only from the handset's own visit form until `keepAsSuspect` landed, so
        this screen drew the answer and refused it rather than offering a box
        that would take a sentence and drop it.

        It is FREE TEXT and not a coded reason, deliberately: the coded lists
        exist so somebody can count an answer later, and there is nothing to
        count here — the useful content is "owner is abroad until Diwali", which
        is a sentence and a date.
      */}
      {answer === "still" ? (
        <div className="mt-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Why is it still a Suspect?
            </span>
            <textarea
              className="min-h-[72px] w-full rounded-[4px] border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
              placeholder="e.g. Owner abroad until Diwali — his brother asked us to call back in November"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <p className="mt-1.5 text-[12px] text-muted">
            The lead stays exactly where it is and stays on this queue — this records why nobody
            has decided yet, so the next person to open it is not asking the same question again.
          </p>
        </div>
      ) : null}

      {missing.length ? (
        <div className="mt-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5">
          <div className="text-[13px] font-medium text-ink">
            Before it can be a Prospect, {plural(missing.length, "thing")} still to do
          </div>
          <ul className="mt-1 list-disc pl-5 text-[13px] text-body">
            {missing.map((m) => (
              <li key={m.field}>{m.message}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] text-muted">
            §6&rsquo;s answers, refused by the gate rather than by this screen. Nothing about the
            visits is wrong — this is what a Prospect is made of.
          </p>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone={answer === "not" ? "danger" : "primary"}
          disabled={
            busy ||
            !answer ||
            (answer === "still" ? note.trim().length < 3 : !reasonCode)
          }
          title={
            answer === "still" && note.trim().length < 3
              ? "Say why in a sentence — this is what the next person reads."
              : !answer
                ? "Pick an answer first."
                : !reasonCode
                  ? "Pick a reason — this is what somebody reads later."
                  : undefined
          }
          onClick={submit}
        >
          {busy ? "Saving…" : answer === "not" ? "Close this lead" : "Make it a Prospect"}
        </Button>
      </div>
    </Modal>
  );
}

function Answer({
  on,
  label,
  hint,
  onPick,
}: {
  on: boolean;
  label: string;
  hint: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={hint}
      className={
        on
          ? "inline-flex cursor-pointer flex-col items-start rounded-[4px] border border-brand bg-brand-soft px-3 py-2 text-left"
          : "inline-flex cursor-pointer flex-col items-start rounded-[4px] border border-line bg-surface px-3 py-2 text-left hover:bg-canvas"
      }
    >
      <span className={on ? "text-sm font-medium text-[#5223E0]" : "text-sm text-body"}>
        {label}
      </span>
      <span className="text-[12px] text-muted">{hint}</span>
    </button>
  );
}
