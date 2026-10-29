"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { stamp, stampDate } from "@/lib/format";
import { lastAnswer, lastFinding, type Remembered } from "@/lib/verification-history";
import {
  REQUIRED_WHEN_VERIFIED,
  isActiveQuestion,
  missingRequiredAnswers,
} from "@/lib/verification-form";
import { Button, cx, Input, Select, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import {
  VERIFICATION_OUTCOMES,
  VERIFICATION_QUESTIONS,
  VERIFICATION_SECTIONS,
  salesTypeLabel,
  stageLabel,
  verificationResultLabel,
  type VerificationOutcome,
} from "@/lib/lead-labels";
import type { LeadStage } from "@/lib/lead-labels";
import { recordLeadValidationCall } from "@/lib/actions/leads";
import type { ManagerCall } from "@/lib/services/lead-console-service";
import { Pill, ScreenHeader } from "@/components/console/parts";
import { Modal } from "@/components/ui/modal";

/* ---------------------------------------------------------------------------
 * §8 — the verification call, at full size.
 *
 * §5.2's four sections and nine findings is a scroll inside a modal, and this is
 * the one form in the funnel somebody fills in WHILE ON THE PHONE. A manager
 * hunting for the question the customer has just answered is a manager who
 * writes the call up afterwards from memory — which is precisely the failure
 * this call exists to catch in the salesman.
 *
 * **THE SALESMAN'S FINDINGS COME FIRST, AND THEY ARE READ-ONLY.** The call is a
 * check on a report, so the report is what is on the screen: what he said they
 * use, whose product they are on, what he thought they were worth. The manager
 * reads each one out and records what the shop says back.
 *
 * **THE ANSWERS ARE NOT WRITTEN OVER THE LEAD'S.** `lead_competitor` is what
 * the salesman was told standing in the shop; `confirmed_competitor` is what
 * the office was told on the phone. The two disagreeing is the single most
 * useful thing this call produces — it is how anybody finds out that the report
 * and the shop did not match — and collapsing them would overwrite the first
 * reading with the second and destroy exactly that. So nothing on this screen
 * touches a `customers` column, and a correction is a SECOND reading beside the
 * first rather than a replacement of it.
 *
 * **NOTHING IS PRE-SELECTED.** No default verdict, no pre-ticked yes, no verdict
 * on the call itself. A form whose every default is the affirmative lets
 * somebody click through it and produce a clean verification without having
 * asked anybody anything, and a clean verification is what opens the gate to
 * qualification.
 *
 * **A REFUSAL AND AN ABSENCE ARE DRAWN APART.** "Unable to verify" is an answer
 * — we asked and could not establish it — and leaving a question blank is not.
 * A null column would say the second about the first, which is the same
 * mistake `mbos_activity_locations` makes a paragraph of: no fix is a recorded
 * fact, not a missing row.
 * ------------------------------------------------------------------------- */

/** One thing the salesman reported, and where an answer about it can land. */
export type Finding = {
  id: string;
  label: string;
  /** His own value, formatted on the server — money is paise until then. */
  reported: string | null;
  /**
   * The `VERIFICATION_QUESTIONS` id whose column holds the shop's answer, or
   * null where `mbos_lead_validations` has no column for this finding at all.
   * The second is a real gap and the screen says so rather than inventing one.
   */
  lands: string | null;
};

type Verdict = "confirmed" | "corrected" | "unverified";

type Answer = { verdict: Verdict | null; corrected: string; reason: string };

type CheckPayload = {
  field: string;
  verdict: Verdict;
  original: string | null;
  corrected?: string;
  reason?: string;
};

const BLANK: Answer = { verdict: null, corrected: "", reason: "" };

const VERDICT_WORD: Record<Verdict, string> = {
  confirmed: "Confirmed",
  corrected: "Corrected",
  unverified: "Could not verify",
};

export function VerifyScreen({
  workspace,
  customerId,
  leadName,
  detail,
  salesType,
  stage,
  findings,
  priorCalls,
  failureReasons,
  canVerify,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  customerId: string;
  leadName: string;
  detail: string;
  salesType: "direct" | "third_party" | "distributor" | null;
  stage: LeadStage;
  findings: Finding[];
  priorCalls: ManagerCall[];
  /** §26's configured codes, for the one outcome that closes the lead. */
  /** §8's seven findings. NOT the loss reasons — the loss code is fixed. */
  failureReasons: { code: string; label: string }[];
  canVerify: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [answers, setAnswers] = React.useState<Record<string, Answer>>({});
  const [questions, setQuestions] = React.useState<Record<string, string>>({});
  const [verdict, setVerdict] = React.useState<VerificationOutcome | null>(null);
  const [failureReason, setFailureReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function answerFor(id: string): Answer {
    return answers[id] ?? BLANK;
  }

  function setAnswer(id: string, patch: Partial<Answer>) {
    setAnswers((a) => ({ ...a, [id]: { ...(a[id] ?? BLANK), ...patch } }));
  }

  /*
   * The three findings that HAVE a column take their question off the free-text
   * list below, because two controls writing one column is how one of them
   * silently wins. Which three is read off the findings rather than written
   * down here — a second list would drift the day a column is added.
   */
  const consumed = new Set(findings.map((f) => f.lands).filter((x): x is string => Boolean(x)));
  /* Hidden questions are not asked on this form; their stored answers stay on
     the record. See `lib/verification-form.ts`. */
  const remaining = VERIFICATION_QUESTIONS.filter((q) => !consumed.has(q.id) && isActiveQuestion(q.id));

  /*
   * ASKED IN §5.2'S OWN FOUR SECTIONS, because seventeen boxes in one grid is a
   * form somebody reads down rather than a call somebody conducts. The headings
   * come off the question list — a heading typed here would be the copy that
   * drifts the day a question moves between sections, and the modal draws the
   * same four.
   *
   * A section every one of whose questions was answered by a finding above is
   * dropped rather than drawn empty: an empty heading reads as a section this
   * screen forgot to build.
   */
  const sections = VERIFICATION_SECTIONS.map((s) => ({
    ...s,
    questions: remaining.filter((q) => q.section === s.id),
  })).filter((s) => s.questions.length > 0);

  const landed = findings.filter((f) => f.lands);
  const unlanded = findings.filter((f) => !f.lands);

  /**
   * What the shop said, as the column will hold it.
   *
   * A confirmation stores the VALUE rather than the word "confirmed": the
   * column's whole job is to hold the shop's own answer, and the difference
   * between it and the `customers` column beside it is what tells anybody the
   * report was wrong. A marker saying "corrected" would be a third copy of a
   * fact the two columns already state by disagreeing.
   *
   * "Could not verify" is stored as words, because a null there would read as a
   * question nobody asked.
   */
  function landedValue(f: Finding): string | null {
    const a = answerFor(f.id);
    if (a.verdict === "confirmed") return f.reported ?? null;
    if (a.verdict === "corrected") return a.corrected.trim() || null;
    if (a.verdict === "unverified") {
      return `Could not verify${a.reason.trim() ? ` — ${a.reason.trim()}` : ""}`;
    }
    return null;
  }

  /**
   * THE PART THAT HAS NOWHERE BETTER TO GO, composed and shown before it is
   * sent.
   *
   * `mbos_lead_validations` carries a column per ANSWER and none for the reason
   * behind a correction, and six of the nine findings have no column of their
   * own at all. Those are recorded here, labelled, in the call's own
   * `verdict_reason` — which is a sentence rather than a queryable answer, so
   * "how many leads had the wrong contact person" is not a question this can
   * answer yet. Saying that plainly is better than storing nothing, and far
   * better than quietly writing it over the salesman's column.
   *
   * It is PREVIEWED rather than composed behind the manager's back: what is
   * about to be stored on a record somebody will read in March is not a thing
   * to assemble invisibly.
   */
  const composedNote = React.useMemo(() => {
    const lines: string[] = [];
    for (const f of findings) {
      const a = answers[f.id];
      if (!a?.verdict) continue;
      /* A confirmation with a column of its own is already recorded there. */
      if (a.verdict === "confirmed" && f.lands) continue;
      const bits = [`${f.label}: ${VERDICT_WORD[a.verdict]}`];
      if (f.reported) bits.push(`salesman said "${f.reported}"`);
      if (a.verdict === "corrected" && a.corrected.trim()) {
        bits.push(`shop says "${a.corrected.trim()}"`);
      }
      if (a.reason.trim()) bits.push(`because ${a.reason.trim()}`);
      lines.push(bits.join(" — "));
    }
    const typed = note.trim();
    if (!lines.length) return typed;
    return [typed, lines.join("\n")].filter(Boolean).join("\n\n");
  }, [findings, answers, note]);

  /* A correction that does not say why is a correction nobody can weigh in
     March, so it is refused here — and the SAME sentence is what the composed
     note carries, so refusing is not a way of losing it. */
  const unreasonedCorrections = findings.filter((f) => {
    const a = answers[f.id];
    return a?.verdict === "corrected" && (!a.corrected.trim() || !a.reason.trim());
  });

  const answered = findings.filter((f) => answers[f.id]?.verdict).length;

  /*
   * §5.2'S FOURTH RESULT, SHOWN AS IT IS EARNED RATHER THAN OFFERED AS A
   * CHOICE.
   *
   * "Verified" and "verified, having corrected three of his figures" are two
   * different statements about a salesman's report, and the second is most of
   * why anybody runs this call. It is DERIVED — see `verificationResultOf` in
   * `lead-labels.ts` — from the correction rows this form is about to write,
   * never stored beside them, because a stored fourth outcome is a second copy
   * of a fact the rows already state and is free to disagree with them.
   *
   * So it is drawn here as a consequence: the manager marks a finding
   * corrected, and the line under "Verified" changes to say what the call will
   * be recorded as. A radio he could pick directly would let him record it with
   * no corrections behind it, which is the disagreement in its first afternoon.
   */
  const correctedCount = findings.filter((f) => answers[f.id]?.verdict === "corrected").length;
  /* Both unsuccessful outcomes demand the sentence, for two different reasons:
     a follow-up's words become the salesman's task, and a failed verification's
     are the only record anybody will have of why a real-looking lead was
     closed. The action demands both again — a form is not a rule. */
  const needsNote = verdict !== null && verdict !== "verified" && !composedNote.trim();
  const needsFailureReason = verdict === "not_qualified" && !failureReason;
  /* What the shop uses now is asked of a SUCCESSFUL verification only. */
  const missingRequired = missingRequiredAnswers(verdict, questions);

  async function submit() {
    if (!verdict) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string> = {};
      for (const [id, value] of Object.entries(questions)) {
        if (value.trim()) payload[id] = value.trim();
      }
      for (const f of landed) {
        const v = landedValue(f);
        if (v && f.lands) payload[f.lands] = v;
      }

      /*
       * EVERY CORRECTION, AS ITS OWN RECORD, and the four with a column send
       * one too.
       *
       * The column holds the shop's ANSWER in the same shape a confirmation
       * leaves it, so it cannot say that the answer DIFFERED, what the salesman
       * had, or why — and the other five findings had nowhere but a labelled
       * line in the note, which is a sentence and not something anybody can
       * count. `original` is sent from here because this screen is the one
       * place holding what the salesman reported at the moment the manager
       * contradicted it: the lead's own column is live and a later visit
       * legitimately overwrites it, so reading it back in March would answer
       * with whatever the field says then.
       *
       * It is what the manager typed, never applied to the lead — the action
       * writes rows and touches no `customers` column, which is the whole
       * point of the table.
       */
      /* EVERY ANSWERED FINDING, as a row of its own — a confirmation and an
         "unable to verify" too, not only a correction. Without a column to land
         in, a row is the only structured place either could be kept. */
      const corrections = findings.flatMap((f): CheckPayload[] => {
        const a = answers[f.id];
        if (!a?.verdict) return [];
        if (a.verdict === "corrected") {
          return [
            {
              field: f.id,
              verdict: "corrected" as const,
              original: f.reported,
              corrected: a.corrected.trim(),
              reason: a.reason.trim(),
            },
          ];
        }
        return [
          {
            field: f.id,
            verdict: a.verdict,
            original: f.reported,
            reason: a.verdict === "unverified" ? a.reason.trim() || undefined : undefined,
          },
        ];
      });

      const result = await recordLeadValidationCall(customerId, {
        answers: payload,
        outcome: verdict,
        followUpNote: composedNote.trim() || undefined,
        failureReasonCode: verdict === "not_qualified" ? failureReason : undefined,
        corrections,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAnswers({});
      setQuestions({});
      setVerdict(null);
      setFailureReason("");
      setNote("");
      toast.push(result.message ?? "Call recorded.");
      router.push(leadHref(workspace, `leads/${customerId}`));
      router.refresh();
    } finally {
      /* Cleared whatever happened. An action that rejects rather than returning
         a Result would otherwise leave the button dead until a reload. */
      setBusy(false);
    }
  }

  const blocked =
    !canVerify ||
    busy ||
    !verdict ||
    unreasonedCorrections.length > 0 ||
    needsNote ||
    needsFailureReason ||
    missingRequired.length > 0;


  const record = leadHref(workspace, `leads/${customerId}`);
  const closeDialog = () => router.push(record);

  /* What the newest earlier call recorded, so reopening shows it. Read-only. */
  const last = priorCalls[0] ?? null;
  const savedFinding = (f: Finding) => lastFinding(priorCalls, f);

  const allFindings = [...landed, ...unlanded];
  const progressTotal = allFindings.length + 1;
  const progressDone = answered + (verdict ? 1 : 0);
  const questionCount = sections.reduce((t, x) => t + x.questions.length, 0);
  const sectionStart = sections.map((_, i) =>
    sections.slice(0, i).reduce((t, x) => t + x.questions.length, allFindings.length),
  );
  const verdictN = allFindings.length + questionCount + 1;

  return (
    <>
      <ScreenHeader
        entity
        title="Verification call"
        subtitle={
          <>
            <Link href={record} className="no-underline">
              {leadName}
            </Link>
            {detail ? ` · ${detail}` : ""} · {salesTypeLabel(salesType)} · {stageLabel(stage)}
          </>
        }
      />

      <Modal
        open
        onClose={closeDialog}
        width={640}
        title={
          <div>
            <div>Verification call</div>
            <div className="mt-0.5 text-[13px] font-normal text-muted">
              {leadName} · {allFindings.length} answers to check ·{" "}
              {questionCount} questions
              {last ? ` · last call ${stamp(last.calledAt)}` : ""}
            </div>
          </div>
        }
        footer={
          <>
            {error ? (
              <span role="alert" className="mr-auto max-w-[320px] text-[11.5px] leading-snug text-danger">
                {error}
              </span>
            ) : (
              <span className="mr-auto max-w-[320px] text-[11.5px] leading-snug text-muted">
                {canVerify
                  ? "Records this call. The salesman’s own answers are never changed."
                  : "View only — you can read this call but not make one."}
              </span>
            )}
            <Button variant="secondary" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={blocked}
              title={
                !canVerify
                  ? "The verification call is a sales manager's. Yours is not one of the hats that carries it."
                  : !verdict
                    ? "Say what the call established before recording it."
                    : unreasonedCorrections.length
                      ? "A correction has to say what the shop said and why the two differ."
                      : missingRequired.length
                        ? "Say what the shop is using now — a verification cannot be recorded without it."
                        : needsFailureReason
                        ? "Closing a lead needs one of the configured reasons."
                        : needsNote
                          ? verdict === "not_qualified"
                            ? "Say what the shop actually said."
                            : "Say what the salesman should do about it."
                          : undefined
              }
              onClick={submit}
            >
              {busy
                ? "Recording…"
                : verdict === "not_qualified"
                  ? "Record and close the lead"
                  : "Record the call"}
            </Button>
          </>
        }
      >
        <div className="mb-2 flex items-center gap-2.5 text-xs text-muted">
          <span>
            <b className="text-ink">
              {progressDone} of {progressTotal}
            </b>{" "}
            answers in
          </span>
          <div className="h-[5px] flex-1 overflow-hidden rounded-[3px] bg-divider">
            <div
              className="h-full bg-brand"
              style={{ width: `${(progressDone / progressTotal) * 100}%` }}
            />
          </div>
        </div>

        {allFindings.map((f, i) => {
          const a = answerFor(f.id);
          return (
            <FindingRow
              key={f.id}
              n={i + 1}
              finding={f}
              answer={a}
              saved={savedFinding(f)}
              disabled={!canVerify}
              onChange={(patch) => setAnswer(f.id, patch)}
            />
          );
        })}

        {sections.map((s, si) => (
          <React.Fragment key={s.id}>
            <div className="mt-3 border-t border-divider pt-3 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
              {s.title}
            </div>
            {s.questions.map((q, qi) => {
              const before = lastAnswer(priorCalls, q.id);
              const typed = Boolean((questions[q.id] ?? "").trim());
              const required = verdict === "verified" && REQUIRED_WHEN_VERIFIED.includes(q.id);
              return (
                <Row
                  key={q.id}
                  n={sectionStart[si] + qi + 1}
                  label={q.ask}
                  done={typed}
                  tag={typed ? "answered" : required ? "needed" : "optional"}
                  tone={typed ? "done" : required ? "needed" : "optional"}
                >
                  {before ? (
                    <Known text={before.text} caption={`Last answered ${stampDate(before.at)}`} />
                  ) : null}
                  <Textarea
                    rows={2}
                    disabled={!canVerify}
                    value={questions[q.id] ?? ""}
                    onChange={(e) => setQuestions((s2) => ({ ...s2, [q.id]: e.target.value }))}
                  />
                </Row>
              );
            })}
          </React.Fragment>
        ))}

        <div className="mt-3 border-t border-divider pt-3 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
          Result of the call
        </div>
        {(() => {
          return (
            <Row
              n={verdictN}
              label="How did the call go?"
              done={Boolean(verdict)}
              tag={verdict ? "answered" : "needed"}
              tone={verdict ? "done" : "needed"}
            >
              <div className="flex flex-col gap-2">
                {VERIFICATION_OUTCOMES.map((o) => (
                  <label
                    key={o.code}
                    title={o.says}
                    className="flex cursor-pointer items-center gap-2 text-[13px] text-body"
                  >
                    <input
                      type="radio"
                      name="call-verdict"
                      className="h-[14px] w-[14px] accent-[#6835FB]"
                      disabled={!canVerify}
                      checked={verdict === o.code}
                      onChange={() => setVerdict(o.code)}
                    />
                    <span className={o.code === "not_qualified" ? "text-danger" : undefined}>
                      {o.label}
                    </span>
                    {o.code === "verified" && correctedCount > 0 ? (
                      <Pill tone="warn">{verificationResultLabel("verified_with_corrections")}</Pill>
                    ) : null}
                  </label>
                ))}
              </div>

              {verdict === "not_qualified" ? (
                <label className="mt-3 block">
                  <span className="mb-1 block text-[12px] text-muted">What the call found</span>
                  <Select
                    className="w-full"
                    disabled={!canVerify}
                    value={failureReason}
                    onChange={(e) => setFailureReason(e.target.value)}
                  >
                    <option value="">Pick one…</option>
                    {failureReasons.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
            </Row>
          );
        })()}

        {/*
         * REMARKS / NEXT ACTION — not a numbered question.
         *
         * It is the call's note, the same `note` the server has always asked
         * for: the sentence that becomes the salesman's task on a follow-up and
         * the record of why a lead was closed on a failed verification. It sits
         * under the result because what it says depends on the result, and it
         * carries no number because it is not something the shop is asked.
         */}
        {(() => {
          const required = verdict === "follow_up" || verdict === "not_qualified";
          const written = Boolean(note.trim());
          return (
            <div className="border-t border-divider py-2.5">
              <div className="mb-1 flex items-baseline justify-between gap-3 text-xs font-bold text-ink">
                <span>Remarks / Next Action</span>
                <span
                  className={cx(
                    "shrink-0 text-[11px] font-semibold",
                    written ? "text-success" : required ? "text-warn-ink" : "text-muted",
                  )}
                >
                  {written ? "answered" : required ? "needed" : "optional"}
                </span>
              </div>
              <Textarea
                rows={2}
                disabled={!canVerify}
                value={note}
                placeholder={
                  verdict === "follow_up"
                    ? "What should the salesman do?"
                    : verdict === "not_qualified"
                      ? "What did the shop actually say?"
                      : undefined
                }
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          );
        })()}
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ parts */

type Tone = "done" | "needed" | "optional" | "error";

/** One numbered question: a badge, its label, a status tag, then the answer. */
function Row({
  n,
  label,
  done,
  tag,
  tone,
  children,
}: {
  n: number;
  label: string;
  done: boolean;
  tag: string;
  tone: Tone;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[26px_1fr] gap-2.5 border-t border-divider py-2.5 first:border-t-0">
      <span
        className={cx(
          "mt-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold",
          done
            ? "bg-success-soft text-success"
            : tone === "optional"
              ? "border border-line bg-divider text-muted"
              : "border border-warn-line bg-warn-soft text-warn-ink",
        )}
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0">
        <div className="mb-1 flex items-baseline justify-between gap-3 text-xs font-bold text-ink">
          <span>{label}</span>
          <span
            className={cx(
              "shrink-0 text-[11px] font-semibold",
              tone === "done"
                ? "text-success"
                : tone === "optional"
                  ? "text-muted"
                  : "text-warn-ink",
            )}
          >
            {tag}
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A value that is already on the record: grey, read-only. */
function Known({ text, caption }: { text: React.ReactNode; caption?: string }) {
  return (
    <div className="mb-1.5 flex min-h-[34px] items-center justify-between gap-3 rounded-[4px] border border-line bg-canvas px-2.5 text-[13px] text-ink">
      <span>{text}</span>
      {caption ? <span className="shrink-0 text-[11px] text-muted">{caption}</span> : null}
    </div>
  );
}

function FindingRow({
  n,
  finding,
  answer,
  saved,
  disabled,
  onChange,
}: {
  n: number;
  finding: Finding;
  answer: Answer;
  /** What the newest earlier call recorded for this finding, if anything. */
  saved: Remembered | null;
  disabled: boolean;
  onChange: (patch: Partial<Answer>) => void;
}) {
  const verdicts: Array<{ v: Verdict; label: string }> = [
    { v: "confirmed", label: "Confirm" },
    { v: "corrected", label: "Correct" },
    { v: "unverified", label: "Unable to verify" },
  ];
  const tag =
    answer.verdict === "confirmed"
      ? "confirmed"
      : answer.verdict === "corrected"
        ? "corrected"
        : answer.verdict === "unverified"
          ? "unable to verify"
          : "to check";

  return (
    <Row
      n={n}
      label={finding.label}
      done={answer.verdict !== null}
      tag={tag}
      tone={answer.verdict ? "done" : "needed"}
    >
      <Known
        text={finding.reported ?? <span className="text-muted">Not recorded</span>}
        caption="Salesman"
      />
      {saved ? <Known text={saved.text} caption={`Last answered ${stampDate(saved.at)}`} /> : null}

      <div className="flex flex-wrap gap-1.5">
        {verdicts.map((o) => (
          <button
            key={o.v}
            type="button"
            disabled={disabled}
            onClick={() => onChange({ verdict: answer.verdict === o.v ? null : o.v })}
            aria-pressed={answer.verdict === o.v}
            className={cx(
              "h-8 cursor-pointer rounded-[4px] border px-3 text-[13px] disabled:cursor-not-allowed disabled:opacity-60",
              answer.verdict === o.v
                ? o.v === "confirmed"
                  ? "border-success bg-success-soft text-ink"
                  : o.v === "corrected"
                    ? "border-warn bg-warn-soft text-ink"
                    : "border-line-strong bg-canvas text-ink"
                : "border-line bg-surface text-body hover:bg-canvas",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {answer.verdict === "corrected" ? (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">What the shop says</span>
            <Input
              disabled={disabled}
              value={answer.corrected}
              onChange={(e) => onChange({ corrected: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">Why it differs</span>
            <Input
              disabled={disabled}
              value={answer.reason}
              onChange={(e) => onChange({ reason: e.target.value })}
            />
          </label>
        </div>
      ) : answer.verdict === "unverified" ? (
        <label className="mt-2 block">
          <span className="mb-1 block text-[12px] text-muted">Why not (optional)</span>
          <Input
            disabled={disabled}
            value={answer.reason}
            onChange={(e) => onChange({ reason: e.target.value })}
          />
        </label>
      ) : null}
    </Row>
  );
}
