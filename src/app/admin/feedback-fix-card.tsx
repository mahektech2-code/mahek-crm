"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import {
  FIX_NEEDS,
  FIX_STAGE_LABELS,
  NEED_HINTS,
  NEED_LABELS,
  UNSURE_BELOW,
  fixActions,
  fixStage,
  needsCode,
  type FixNeed,
} from "@/lib/feedback-fix";
import type { FixView } from "@/lib/services/feedback-fix-service";
import {
  askClaudeToFix,
  checkFixesNow,
  checkWhatItNeeds,
  chooseWhatItNeeds,
  sendToDeveloper,
} from "@/lib/actions/feedback-fix";
import { ADMIN } from "@/lib/admin-routes";

/* ---------------------------------------------------------------------------
 * "Fix it" — the bar under an open report's heading, the canvas's
 * "AI read · what it needs" row.
 *
 * First what it NEEDS (the AI reads every new report; anybody triaging can
 * change the answer). A code change is the only need that reaches GitHub:
 * Send to developer opens an issue, and Ask Claude to fix — a platform
 * administrator's button — labels it for the repository's Claude workflow.
 * Every other need opens "How the team can fix it": the steps, and what to ask
 * the reporter, so the fix happens today without a developer.
 * ------------------------------------------------------------------------- */

const STAGE_TONE: Record<ReturnType<typeof fixStage>, string> = {
  none: "bg-canvas text-body",
  read: "bg-warn-soft text-warn-ink",
  team: "bg-brand-soft text-brand-deep",
  issue: "bg-brand-soft text-brand-deep",
  claude: "bg-brand-soft text-brand-deep",
  pr: "bg-warn-soft text-warn-ink",
  merged: "bg-success-soft text-success",
  live: "bg-success-soft text-success",
  closed_pr: "bg-danger-soft text-danger",
};

export function FixCard({
  reportId,
  reportRef,
  fix,
  platformAdmin,
  connected,
  aiEnabled,
  extra,
}: {
  /** More buttons at the bar's end — the report's own "Copy for developer". */
  extra?: React.ReactNode;
  reportId: string;
  reportRef: string;
  fix: FixView | null;
  platformAdmin: boolean;
  connected: boolean;
  aiEnabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [howTo, setHowTo] = React.useState(false);
  const [confirmClaude, setConfirmClaude] = React.useState(false);

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) {
    setBusy(key);
    setNote(null);
    const r = await fn();
    setBusy(null);
    setNote(r.ok ? { ok: true, text: r.message ?? "Done." } : { ok: false, text: r.error ?? "That did not work." });
    if (r.ok) {
      after?.();
      router.refresh();
    }
  }

  const stage = fixStage(fix);
  const need = fix?.need ?? null;
  const d = fix?.diagnosis ?? null;
  const acts = fixActions(fix, { platformAdmin, connected });
  const unsure = d && !fix?.needByPerson && d.confidence < UNSURE_BELOW;

  const sm = "inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-control border px-2.5 text-xs font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50";
  const plain = cx(sm, "border-line-strong bg-surface text-ink hover:bg-[#f7f9fc]");
  const dark = cx(sm, "border-ink bg-ink text-white hover:bg-[#1c2a47]");
  const why = [need ? NEED_HINTS[need] : null, d?.summary].filter(Boolean).join(" — ");

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-divider bg-[#fbfaff] px-4 py-3">
        <span className="inline-flex h-[22px] items-center rounded-full bg-[#eef0fb] px-2 text-xs font-semibold whitespace-nowrap text-[#343e96]">
          {fix?.needByPerson ? "Chosen by a person" : d ? `AI read · ${Math.round(d.confidence)}% sure` : "AI read · what it needs"}
        </span>
        <label className="flex items-center gap-1">
          <span className="sr-only">What it needs</span>
          <select
            value={need ?? ""}
            disabled={!!busy}
            onChange={(e) => e.target.value && run("need", () => chooseWhatItNeeds(reportId, e.target.value as FixNeed))}
            className="max-w-[220px] cursor-pointer bg-transparent text-[13px] font-bold text-ink outline-none"
          >
            {need ? null : <option value="">{aiEnabled ? "Not read yet" : "Choose what it needs"}</option>}
            {FIX_NEEDS.map((n) => (
              <option key={n} value={n}>
                {NEED_LABELS[n]}
              </option>
            ))}
          </select>
        </label>
        {why ? (
          <button
            type="button"
            title={why}
            aria-label={`Why: ${why}`}
            className="h-5 w-5 flex-none cursor-help rounded-full border border-line-strong bg-surface p-0 text-[11px] font-semibold text-muted"
          >
            i
          </button>
        ) : null}
        {unsure ? <span className="text-xs font-semibold text-warn-ink">Check before acting</span> : null}
        {stage !== "none" && stage !== "read" ? (
          <span className={cx("rounded-full px-2 py-px text-[11px] font-semibold whitespace-nowrap", STAGE_TONE[stage])}>
            {FIX_STAGE_LABELS[stage]}
          </span>
        ) : null}
        <span className="flex-1" />
        {aiEnabled ? (
          <button type="button" className={plain} disabled={!!busy} onClick={() => run("read", () => checkWhatItNeeds(reportId))}>
            {busy === "read" ? "Reading…" : need ? "Read it again" : "Check what it needs"}
          </button>
        ) : null}
        {need && !needsCode(need) ? (
          <button type="button" className={dark} onClick={() => setHowTo(true)}>
            How the team can fix it
          </button>
        ) : null}
        {needsCode(need) && acts.sendToDeveloper ? (
          <button type="button" className={plain} disabled={!!busy} onClick={() => run("issue", () => sendToDeveloper(reportId))}>
            {busy === "issue" ? "Sending…" : "Send to developer"}
          </button>
        ) : null}
        {needsCode(need) && acts.askClaude ? (
          <button type="button" className={dark} disabled={!!busy} onClick={() => setConfirmClaude(true)}>
            Ask Claude to fix
          </button>
        ) : needsCode(need) && acts.askClaudeWhyNot && connected ? (
          <button type="button" className={dark} disabled title={acts.askClaudeWhyNot}>
            Ask Claude to fix
          </button>
        ) : null}
        {extra}
      </div>

      {needsCode(need) && !connected ? (
        <div className="border-b border-divider px-4 py-2 text-xs text-muted">
          GitHub is not connected.{" "}
          <a href={`${ADMIN.integrations}#github`} className="font-medium">
            Connect it
          </a>{" "}
          to send this to the developer, or use Copy for developer.
        </div>
      ) : null}

      {fix?.issueUrl ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-divider px-4 py-2 text-xs text-body">
          <a href={fix.issueUrl} target="_blank" rel="noreferrer" className="font-medium">
            Issue #{fix.issueNumber} ↗
          </a>
          {fix.aiFixRequestedAt ? <span>Claude asked{fix.aiFixRequestedByName ? ` by ${fix.aiFixRequestedByName}` : ""}</span> : null}
          {fix.prUrl ? (
            <span>
              <a href={fix.prUrl} target="_blank" rel="noreferrer" className="font-medium">
                Pull request #{fix.prNumber} ↗
              </a>{" "}
              · {fix.prState === "merged" ? "merged" : fix.prState === "open" ? "waiting for review" : "closed without merging"}
            </span>
          ) : (
            <span className="text-muted">No pull request yet</span>
          )}
          {fix.deployedAt ? (
            <span className="font-medium text-success">Live — the report closed itself</span>
          ) : (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run("check", () => checkFixesNow())}
              className="cursor-pointer text-xs font-medium text-brand hover:underline disabled:text-muted"
            >
              {busy === "check" ? "Checking…" : "Check now"}
            </button>
          )}
        </div>
      ) : null}

      {note ? (
        <div className={cx("border-b border-divider px-4 py-2 text-xs", note.ok ? "text-success" : "text-danger")} role="status">
          {note.text}
        </div>
      ) : null}

      <HowToDialog open={howTo} onClose={() => setHowTo(false)} fix={fix} reportRef={reportRef} />

      <Modal
        open={confirmClaude}
        onClose={() => setConfirmClaude(false)}
        title="Ask Claude to fix this?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClaude(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!!busy}
              onClick={() => run("claude", () => askClaudeToFix(reportId), () => setConfirmClaude(false))}
            >
              {busy === "claude" ? "Asking…" : "Ask Claude"}
            </Button>
          </>
        }
      >
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-5 text-body">
          <li>
            {fix?.issueNumber ? `Issue #${fix.issueNumber} is labelled for Claude.` : "A GitHub issue is opened with the report, the conversation and where to look."}
          </li>
          <li>Claude reads the code, writes the fix and a test, and opens a pull request.</li>
          <li>A person reviews the pull request and merges it — nothing goes live on its own.</li>
          <li>Once the fix is live, {reportRef} closes itself and everybody who reported it is told.</li>
        </ol>
        <p className="mt-3 text-xs leading-[17px] text-muted">
          Phone numbers, emails and GST numbers are taken out of what goes to GitHub. Names stay, so the fix can be checked
          against the right customer.
        </p>
      </Modal>
    </div>
  );
}

function HowToDialog({
  open,
  onClose,
  fix,
  reportRef,
}: {
  open: boolean;
  onClose: () => void;
  fix: FixView | null;
  reportRef: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const need = fix?.need ?? null;
  const d = fix?.diagnosis ?? null;
  const steps = d?.steps ?? [];

  async function copy() {
    const text = [d?.summary, ...steps.map((s, i) => `${i + 1}. ${s}`)].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={`How the team can fix ${reportRef}`}
      footer={
        <>
          {steps.length ? (
            <Button variant="secondary" onClick={copy}>
              {copied ? "Copied" : "Copy the steps"}
            </Button>
          ) : null}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {need ? (
        <div className="rounded-[8px] bg-brand-soft px-3.5 py-2.5">
          <div className="text-sm font-semibold text-brand-deep">{NEED_LABELS[need]}</div>
          <div className="mt-0.5 text-[13px] leading-[18px] text-body">{NEED_HINTS[need]}</div>
        </div>
      ) : null}
      {d?.summary ? <p className="mt-3 text-sm leading-5 text-ink">{d.summary}</p> : null}
      {steps.length ? (
        <>
          <div className="mt-3 text-xs font-semibold text-ink">Steps</div>
          <ol className="mt-1.5 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-5 text-body">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      ) : (
        <p className="mt-3 text-sm leading-5 text-muted">
          No steps were written for this one. Read the report, fix it on the screen it names, and reply to say so.
        </p>
      )}
      {d?.question ? (
        <div className="mt-3 rounded-[8px] border border-line px-3.5 py-2.5">
          <div className="text-xs font-semibold text-ink">Ask the reporter first</div>
          <div className="mt-0.5 text-sm leading-5 text-body">{d.question}</div>
        </div>
      ) : null}
      {d && d.confidence < UNSURE_BELOW ? (
        <p className="mt-3 text-xs leading-[17px] text-warn-ink">
          The AI was only {Math.round(d.confidence)}% sure. Check the steps against the screen before following them.
        </p>
      ) : null}
      <p className="mt-3 text-xs leading-[17px] text-muted">
        When it is fixed, reply on the thread and set the status to Done — that closes it and tells them. If it turns out the
        code is wrong after all, change “It needs” to a change to the code.
      </p>
    </Modal>
  );
}
