"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { stamp } from "@/lib/format";
import { cx, Input, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import {
  VERIFICATION_OUTCOMES,
  VERIFICATION_QUESTIONS,
  VERIFICATION_SECTIONS,
  salesTypeLabel,
  stageLabel,
  verificationResultLabel,
  verificationResultOf,
  type VerificationOutcome,
} from "@/lib/lead-labels";
import type { LeadStage } from "@/lib/lead-labels";
import { recordLeadValidationCall } from "@/lib/actions/leads";
import type { ManagerCall } from "@/lib/services/lead-console-service";
import { Banner, Button, Pill, ScreenHeader } from "@/components/console/parts";
import { plural } from "@/components/console/words";

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
  const remaining = VERIFICATION_QUESTIONS.filter((q) => !consumed.has(q.id));

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
      const corrections = findings.flatMap((f) => {
        const a = answers[f.id];
        if (a?.verdict !== "corrected") return [];
        return [
          {
            field: f.id,
            original: f.reported,
            corrected: a.corrected.trim(),
            reason: a.reason.trim(),
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
    needsFailureReason;

  return (
    <div className="p-6">
      <ScreenHeader
        title="Verification call"
        subtitle={
          <>
            <Link href={leadHref(workspace, `leads/${customerId}`)} className="no-underline">
              {leadName}
            </Link>
            {detail ? ` · ${detail}` : ""} · {salesTypeLabel(salesType)} · {stageLabel(stage)}
          </>
        }
        actions={
          <Link
            href={leadHref(workspace, `leads/${customerId}`)}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            ← Back to the record
          </Link>
        }
      />

      {canVerify ? null : (
        <Banner
          tone="warn"
          title="You can read this call and you cannot make one"
          body="The verification call is a sales manager's — `lead.verify`, checked in the action and not only by greying the button. Everything below is drawn so the answers already on the record can be read."
        />
      )}

      {priorCalls.length ? (
        <Banner
          tone="info"
          title={`${plural(priorCalls.length, "call")} already made`}
          /* WHAT THE LAST CALL CAME TO, and not merely when it was. A manager
             about to ring the same shop is deciding whether to ask the same
             questions again, and "verified, and three of his figures were
             wrong" is a different afternoon to "verified". The words are
             DERIVED from that call's own correction rows rather than read off a
             stored fourth outcome — nothing here can disagree with the rows
             below it, because it is the rows. */
          body={`The newest was ${stamp(priorCalls[0].calledAt)} by ${priorCalls[0].managerName ?? "a manager"} and came to “${verificationResultLabel(
            verificationResultOf(
              priorCalls[0].verified,
              /* Every row this door writes is a CORRECTION — a confirmation on a
                 validation call was never worth a row, which is what `0154`'s
                 own comment says. The day `LeadCorrection` starts carrying the
                 other two verdicts this has to count only the corrected ones,
                 and it will be a filter here rather than a second definition. */
              priorCalls[0].corrections.length,
            ),
          )}”. A lead is routinely validated twice and the first call is usually the one that matters, so this writes a new row rather than editing that one.`}
        />
      ) : null}

      <p className="mb-4 max-w-[760px] text-[13px] text-pretty text-muted">
        Read each finding out and record what the shop says back. Nothing here is written over the
        salesman&rsquo;s own answers — his stay on the lead and the shop&rsquo;s are stored beside
        them, because the two disagreeing is the single most useful thing this call produces. Every
        correction is kept as a record of its own, with what he had, what the shop says, why the two
        differ and who was told.
        {" "}
        {answered} of {findings.length} findings answered.
      </p>

      {/* ------------------------------------------ the salesman's findings */}

      <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
        <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          What the salesman reported
        </div>
        <p className="mb-3 max-w-[620px] text-[12px] text-pretty text-muted">
          Read-only. Confirm it, correct it, or say the customer could not confirm it — the third
          is an answer rather than a blank, and it is stored as one.
        </p>

        {findings.length === 0 ? (
          <p className="text-[13px] text-muted">
            The salesman has recorded nothing about this shop yet, so there is nothing to check.
            The twelve questions below are still worth asking.
          </p>
        ) : (
          <div className="flex flex-col gap-3.5">
            {landed.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                answer={answerFor(f.id)}
                disabled={!canVerify}
                onChange={(patch) => setAnswer(f.id, patch)}
              />
            ))}
          </div>
        )}
      </section>

      {/* --------------------------------- the findings with nowhere to land */}

      {unlanded.length ? (
        <section className="mb-4 rounded-[6px] border border-warn bg-surface px-5 py-4">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Asked, and recorded only in words
            </span>
            <Pill tone="warn">No column</Pill>
          </div>
          <p className="mb-3 max-w-[620px] text-[12px] text-pretty text-muted">
            <code>mbos_lead_validations</code> carries a column for each of §8&rsquo;s twelve
            answers and none for these {unlanded.length}. A CORRECTION here is still a record of
            its own &mdash; it goes to <code>lead_verification_corrections</code> with what the
            salesman had, what the shop says and why, so &ldquo;how many leads had the wrong
            contact person&rdquo; is a question somebody can ask. What is left in words is a
            confirmation or an &ldquo;unable to verify&rdquo; on one of these {unlanded.length}:
            those have no column and no correction row, so they are kept in the call&rsquo;s own
            note at the bottom of this page. Neither is written over the salesman&rsquo;s columns,
            which is the one thing this call must never do.
          </p>
          <div className="flex flex-col gap-3.5">
            {unlanded.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                answer={answerFor(f.id)}
                disabled={!canVerify}
                onChange={(patch) => setAnswer(f.id, patch)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* ---------------------------------------------------- the questions */}

      <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
        <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          The rest of the call
        </div>
        <p className="mb-4 max-w-[620px] text-[12px] text-pretty text-muted">
          {consumed.size
            ? `${plural(consumed.size, "question")} are answered by the findings above and are not asked twice — two controls writing one column is how one of them silently wins. `
            : ""}
          Nothing here is required. A gate refuses a MOVE; this is a record of a conversation, and
          a customer who would not say what he uses in a month is a fact about the call rather than
          an error in the form.
          {" "}
          An answer of &ldquo;no&rdquo; belongs in the box rather than left blank: a blank column
          says nobody asked, which is a different fact and reads as one.
        </p>

        <div className="flex flex-col gap-5">
          {sections.map((s) => (
            <div key={s.id}>
              <div className="mb-0.5 text-[13px] font-medium text-ink">{s.title}</div>
              <p className="mb-2.5 max-w-[620px] text-[12px] text-pretty text-muted">{s.says}</p>
              <div className="grid grid-cols-1 gap-x-8 gap-y-3 lg:grid-cols-2">
                {s.questions.map((q) => (
                  <label key={q.id} className="block">
                    <span className="mb-1 block text-[13px] text-body">{q.ask}</span>
                    <Textarea
                      rows={2}
                      disabled={!canVerify}
                      value={questions[q.id] ?? ""}
                      onChange={(e) => setQuestions((s2) => ({ ...s2, [q.id]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ the verdict */}

      <section className="mb-4 rounded-[6px] border border-line bg-surface px-5 py-4">
        <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          What this call establishes
        </div>
        <p className="mb-3 max-w-[620px] text-[12px] text-pretty text-muted">
          The only thing on this page the rest of the funnel reads. Two of the three are about our
          own salesman and one is about the shop, and telling them apart is the whole of this
          choice: a call that went badly, or a salesman nobody could reach, is a follow-up.
          &ldquo;There is no opportunity here&rdquo; is for a lead that turns out to be false, and
          it closes the record.
        </p>

        <div className="flex flex-col gap-2.5">
          {VERIFICATION_OUTCOMES.map((o) => (
            <label
              key={o.code}
              className="flex cursor-pointer items-start gap-2 text-[13px] text-body"
            >
              <input
                type="radio"
                name="call-verdict"
                className="mt-[3px] h-[14px] w-[14px] accent-[#6835FB]"
                disabled={!canVerify}
                checked={verdict === o.code}
                onChange={() => setVerdict(o.code)}
              />
              <span>
                <span className={o.code === "not_qualified" ? "text-danger" : undefined}>
                  {o.label}
                </span>
                {/* WHAT IT COSTS, SAID BEFORE THE BUTTON IS PRESSED. A closure
                    explained only in the toast that follows it is one somebody
                    finds out about from the salesman whose lead went. */}
                <span className="mt-0.5 block max-w-[620px] text-[12px] text-pretty text-muted">
                  {o.says}
                  {o.code === "verified" && correctedCount > 0 ? (
                    <>
                      {" "}
                      <strong className="text-body">
                        This call will read as &ldquo;
                        {verificationResultLabel("verified_with_corrections")}&rdquo;
                      </strong>{" "}
                      &mdash; you have corrected {plural(correctedCount, "finding")}. Nothing extra
                      is stored for it: it is read off the correction rows themselves, so the count
                      and the words can never disagree.
                    </>
                  ) : null}
                </span>
              </span>
            </label>
          ))}
          {verdict === null ? (
            <span className="text-[12px] text-muted">
              Nothing is chosen. There is no default here on purpose — a form that starts on
              &ldquo;verified&rdquo; is a gate somebody opens by pressing save.
            </span>
          ) : null}
        </div>

        {/* §26's codes, offered only under the outcome that spends one. Drawn
            all the time it would be a reason field on a call that closes
            nothing, which is how a lead ends up carrying a lost reason it was
            never lost for. The list is the CONFIGURED one, handed down by the
            page — a reason list typed into a screen is the same mistake as a
            product list typed into a screen. */}
        {verdict === "not_qualified" ? (
          <label className="mt-3.5 block max-w-[520px]">
            <span className="mb-1 block text-[13px] text-body">
              What the call found — required
            </span>
            <select
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2 text-[13px] text-body"
              disabled={!canVerify}
              value={failureReason}
              onChange={(e) => setFailureReason(e.target.value)}
            >
              <option value="">Pick what the call found</option>
              {failureReasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] text-muted">
              The lead closes as <strong>Verification failed</strong> either way &mdash; that
              code is fixed, and is deliberately not &ldquo;wrong lead&rdquo;, which means
              something else. This is the second question, and it is the half anybody can act
              on: denied visits are a salesman problem, duplicates are an intake problem.
            </span>
          </label>
        ) : null}

        <label className="mt-3.5 block">
          <span className="mb-1 block text-[13px] text-body">
            {verdict === "not_qualified"
              ? "What the shop actually said — required"
              : `What the salesman should do about it${verdict === "follow_up" ? " — required" : " — optional"}`}
          </span>
          <Textarea
            rows={3}
            disabled={!canVerify}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="mt-1 block text-[12px] text-muted">
            {verdict === "not_qualified"
              ? "The shop’s own words, because this is the whole of what anybody reading the closure in March will have. It goes to the salesman as well — the lead he was working has just gone, and this says why."
              : "This sentence is what lands on his list, so it has to be an instruction rather than a verdict."}
          </span>
        </label>

        {composedNote.trim() ? (
          <div className="mt-3 rounded-[4px] border border-divider bg-canvas px-3 py-2">
            <div className="mb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Stored on the call, exactly as written
            </div>
            <pre className="m-0 font-sans text-[12px] whitespace-pre-wrap text-body">
              {composedNote}
            </pre>
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="mb-3 text-[13px] text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          tone="primary"
          disabled={blocked}
          title={
            !canVerify
              ? "The verification call is a sales manager's. Yours is not one of the hats that carries it."
              : !verdict
                ? "Say what the call established before recording it."
                : unreasonedCorrections.length
                  ? "A correction has to say what the shop said and why the two differ."
                  : needsFailureReason
                  ? "Closing a lead needs one of the configured reasons."
                  : needsNote
                    ? verdict === "not_qualified"
                      ? "Closing a lead as a false opportunity has to say what the shop actually said."
                      : "A call that could not confirm the visit has to say what the salesman should do about it."
                    : undefined
          }
          onClick={submit}
        >
          {busy
            ? "Recording…"
            : verdict === "not_qualified"
              ? "Record the call and close the lead"
              : "Record the call"}
        </Button>
        <Link
          href={leadHref(workspace, `leads/${customerId}`)}
          className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
        >
          Cancel
        </Link>
        {unreasonedCorrections.length ? (
          <span className="text-[13px] text-warn-ink">
            {plural(unreasonedCorrections.length, "correction")} still needs the shop&rsquo;s own
            answer and a reason.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

/**
 * One finding, its verdict, and — only on a correction — the two fields that
 * make a correction a record rather than an overwrite.
 *
 * Confirm and "could not verify" reveal nothing, because neither has anything
 * more to say: the first restates a value already on the screen and the second
 * is the whole of its own answer. Drawing a corrected-value box under all three
 * would invite somebody to type into it under a verdict that discards it.
 */
function FindingRow({
  finding,
  answer,
  disabled,
  onChange,
}: {
  finding: Finding;
  answer: Answer;
  disabled: boolean;
  onChange: (patch: Partial<Answer>) => void;
}) {
  const verdicts: Array<{ v: Verdict; label: string; tone: string }> = [
    { v: "confirmed", label: "Confirm", tone: "border-success" },
    { v: "corrected", label: "Correct", tone: "border-warn" },
    { v: "unverified", label: "Unable to verify", tone: "border-divider" },
  ];

  return (
    <div
      className={cx(
        "border-l-[3px] pl-3",
        answer.verdict === "confirmed"
          ? "border-success"
          : answer.verdict === "corrected"
            ? "border-warn"
            : answer.verdict === "unverified"
              ? "border-line-strong"
              : "border-divider",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          {finding.label}
        </span>
        <span className="text-[14px] font-medium text-ink">
          {finding.reported ?? <span className="text-muted">He recorded nothing</span>}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        {verdicts.map((o) => (
          <label
            key={o.v}
            className="flex cursor-pointer items-center gap-1.5 text-[13px] text-body"
          >
            <input
              type="radio"
              name={`finding-${finding.id}`}
              className="h-[14px] w-[14px] accent-[#6835FB]"
              disabled={disabled}
              checked={answer.verdict === o.v}
              onChange={() => onChange({ verdict: o.v })}
            />
            {o.label}
          </label>
        ))}
        {answer.verdict === null ? (
          <span className="text-[12px] text-muted">Not asked yet</span>
        ) : null}
      </div>

      {answer.verdict === "corrected" ? (
        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">
              What the shop actually says
            </span>
            <Input
              disabled={disabled}
              value={answer.corrected}
              onChange={(e) => onChange({ corrected: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-muted">
              Why the two differ
            </span>
            <Input
              disabled={disabled}
              value={answer.reason}
              onChange={(e) => onChange({ reason: e.target.value })}
            />
          </label>
        </div>
      ) : answer.verdict === "unverified" ? (
        <label className="mt-2 block max-w-[520px]">
          <span className="mb-1 block text-[12px] text-muted">
            Why not — optional, and it is stored with the answer rather than instead of it
          </span>
          <Input
            disabled={disabled}
            value={answer.reason}
            onChange={(e) => onChange({ reason: e.target.value })}
          />
        </label>
      ) : null}
    </div>
  );
}
