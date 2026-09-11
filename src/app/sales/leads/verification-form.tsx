"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { VERIFICATION_QUESTIONS } from "@/lib/lead-labels";
import { recordLeadValidationCall } from "@/lib/actions/leads";
import { Button } from "../parts";

/**
 * §8 — the sales manager's verification call, as one screen.
 *
 * **All twelve on one screen, never a wizard.** The manager is on the phone
 * while they fill it in and the customer is not going to wait for a "next"
 * button; more to the point, the answers are asked in whatever order the
 * conversation takes them, and a form that insists on an order is a form
 * somebody fills in afterwards from memory. Which is precisely the failure
 * this call exists to catch in the salesman.
 *
 * **Nothing is required.** A gate refuses a MOVE; this is a record of a
 * conversation, and a customer who would not say what he uses in a month is a
 * fact about that call rather than a form error. What is required is the
 * verdict, which is the only thing the rest of the funnel reads.
 *
 * **Both verdicts write the timeline.** Verified opens the gate to
 * Qualification; follow-up required does not, and it is NOT a failure of the
 * lead — the specification makes it a task back on the salesman. Recording
 * only the successes would leave a lead that has been rung three times looking
 * exactly like one nobody has rung at all.
 *
 * The first two questions are drawn apart from the other ten, because they are
 * about the SALESMAN rather than the sale and they are the reason the call
 * exists: no amount of GPS proves that Mahek was explained properly.
 */
export function VerificationForm({
  customerId,
  customerName,
  detail,
  /** What the salesman already established, shown so it is not asked twice. */
  known,
  open,
  onClose,
  onDone,
}: {
  customerId: string;
  customerName: string;
  detail?: string;
  known?: Array<{ label: string; value: string }>;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [verdict, setVerdict] = React.useState<"verified" | "follow_up" | null>(null);
  const [followUpNote, setFollowUpNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (!verdict) return;
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await recordLeadValidationCall(customerId, {
        answers,
        verified: verdict === "verified",
        followUpNote: followUpNote.trim() || undefined,
      });
    } finally {
      /* Cleared whatever happened. An action that rejects rather than
         returning a Result would otherwise leave the button dead until the
         page was reloaded. */
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
    toast.push(result.message ?? "Call recorded.");
    onDone?.();
    router.refresh();
  }

  const [salesmanQs, customerQs] = [
    VERIFICATION_QUESTIONS.slice(0, 2),
    VERIFICATION_QUESTIONS.slice(2),
  ];

  return (
    <Modal open={open} onClose={onClose} title="Verification call" width={720}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{customerName}</div>
        {detail ? <div className="text-muted">{detail}</div> : null}
        {known?.length ? (
          <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
            {known.map((k) => (
              <span key={k.label}>
                {k.label}: <span className="text-body">{k.value}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="max-h-[46vh] overflow-y-auto pr-1">
        <Section title="About our man — this is why the call exists">
          {salesmanQs.map((q) => (
            <Ask key={q.id} q={q} value={answers[q.id] ?? ""} onChange={setAnswers} />
          ))}
        </Section>
        <Section title="About the opportunity">
          {customerQs.map((q) => (
            <Ask key={q.id} q={q} value={answers[q.id] ?? ""} onChange={setAnswers} />
          ))}
        </Section>
      </div>

      <div className="mt-4 border-t border-divider pt-3">
        <div className="mb-1 text-[13px] font-medium text-ink">Your answer</div>
        <div className="flex flex-wrap gap-2">
          <Verdict
            on={verdict === "verified"}
            tone="success"
            label="Verified"
            hint="The visit happened, Mahek was explained, and there is something here. Qualification opens."
            onPick={() => setVerdict("verified")}
          />
          <Verdict
            on={verdict === "follow_up"}
            tone="warn"
            label="Follow-up required"
            hint="Not a refusal — a task back on the salesman. The lead stays where it is."
            onPick={() => setVerdict("follow_up")}
          />
        </div>

        <label className="mt-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            {verdict === "follow_up" ? "What has to happen · required" : "Anything to add"}
          </span>
          <textarea
            value={followUpNote}
            onChange={(e) => setFollowUpNote(e.target.value)}
            rows={2}
            placeholder={
              verdict === "follow_up"
                ? "The salesman has to be able to do something differently"
                : "Goes on the timeline with the call"
            }
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
      </div>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || !verdict || (verdict === "follow_up" && !followUpNote.trim())}
          title={
            !verdict
              ? "Say whether this is verified — it is the only part the rest of the funnel reads."
              : verdict === "follow_up" && !followUpNote.trim()
                ? "Say what has to happen. The salesman cannot work it out from the words alone."
                : undefined
          }
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Record the call"}
        </Button>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">{children}</div>
    </div>
  );
}

function Ask({
  q,
  value,
  onChange,
}: {
  q: { id: string; ask: string };
  value: string;
  onChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] text-body">{q.ask}</span>
      <input
        value={value}
        onChange={(e) => onChange((prev) => ({ ...prev, [q.id]: e.target.value }))}
        className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
      />
    </label>
  );
}

function Verdict({
  on,
  tone,
  label,
  hint,
  onPick,
}: {
  on: boolean;
  tone: "success" | "warn";
  label: string;
  hint: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={hint}
      className={[
        "min-w-[260px] flex-1 cursor-pointer rounded-[6px] border px-3 py-2.5 text-left",
        on
          ? tone === "success"
            ? "border-success bg-success-soft"
            : "border-warn bg-warn-soft"
          : "border-line bg-surface hover:bg-canvas",
      ].join(" ")}
    >
      <span className="block text-[13px] font-semibold text-ink">{label}</span>
      <span className="mt-0.5 block text-[12px] text-pretty text-muted">{hint}</span>
    </button>
  );
}
