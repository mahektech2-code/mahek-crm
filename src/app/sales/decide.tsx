"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { money, parseRupees } from "@/lib/format";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { decideApproval, type ApprovalDecision } from "@/lib/actions/sales";
import { Button } from "./parts";

/**
 * Answering a request, on the screen it is seen on.
 *
 * The design splits the queue across Leave, Expenses and Samples so each kind
 * is decided in context — a leave request beside the calendar of who else is
 * off, an expense beside what that person has already claimed this month. That
 * context is most of the decision, and a combined queue throws it away.
 *
 * What must NOT split is the rules. A refusal needs a reason; a partial needs
 * an amount; a decision is made once. Three copies of that is how one of them
 * ends up more generous than the others without anybody deciding it should be
 * — so this is one component, and the server checks all of it again anyway.
 */
export function Decide({
  approvalId,
  what,
  who,
  /** Present where the request has a figure — an expense, an order. */
  amountPaise,
  size = "sm",
}: {
  approvalId: string | null;
  /** "Casual leave, 18–19 Aug" — what is being answered, in words. */
  what: string;
  who: string;
  amountPaise?: number | null;
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState<ApprovalDecision | null>(null);
  const [note, setNote] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!approvalId) {
    return (
      <span
        className="text-[12px] text-muted"
        title="No approval was raised for this. It reaches the office only when the handset raises one."
      >
        no request
      </span>
    );
  }

  function begin(decision: ApprovalDecision) {
    setOpen(decision);
    setNote("");
    setAmount(amountPaise ? String(Math.round(amountPaise / 100)) : "");
    setError(null);
  }

  async function submit() {
    if (!open || !approvalId) return;
    setBusy(true);
    setError(null);

    let result;
    try {
      result = await decideApproval({
        approvalId,
        decision: open,
        note: note.trim() || undefined,
        approvedAmountPaise:
          open === "partially_approved" ? (parseRupees(amount) ?? undefined) : undefined,
      });
    } finally {
      // Cleared whatever happened: an action that rejects rather than
      // returning a Result would otherwise leave this button disabled
      // until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(null);
    toast.push(result.message ?? "Answered.");
    router.refresh();
  }

  return (
    <>
      <span className="flex flex-none gap-1.5">
        <Button size={size} tone="primary" onClick={() => begin("approved")}>
          Approve
        </Button>
        {amountPaise ? (
          <Button size={size} onClick={() => begin("partially_approved")}>
            Part
          </Button>
        ) : null}
        <Button size={size} tone="danger" onClick={() => begin("rejected")}>
          Refuse
        </Button>
      </span>

      <Modal
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={
          open === "approved"
            ? "Approve this"
            : open === "partially_approved"
              ? "Approve part of it"
              : "Refuse this"
        }
        width={520}
      >
        <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
          <div className="font-medium text-ink">{what}</div>
          <div className="text-muted">
            {who}
            {amountPaise ? ` · ${money(amountPaise)} asked for` : ""}
          </div>
        </div>

        {open === "partially_approved" ? (
          <label className="mb-3 block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Amount you are allowing
            </span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="numeric"
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            />
            <span className="mt-1 block text-[12px] text-muted">
              In rupees. Approving less than was asked for is a different answer from yes, and
              recording it as yes loses the difference on payday.
            </span>
          </label>
        ) : null}

        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            {open === "approved" ? "Anything to add (optional)" : "Why"}
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={
              open === "approved"
                ? "Goes to their handset with the answer"
                : "They have to be able to do something differently"
            }
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>

        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(null)}>
            Cancel
          </Button>
          <Button
            tone={open === "rejected" ? "danger" : "primary"}
            disabled={busy || (open !== "approved" && !note.trim())}
            title={
              open !== "approved" && !note.trim()
                ? "Say why — they cannot work it out from the word alone."
                : undefined
            }
            onClick={() => void submit()}
          >
            {busy
              ? "Saving…"
              : open === "approved"
                ? "Approve"
                : open === "partially_approved"
                  ? "Approve part"
                  : "Refuse"}
          </Button>
        </div>

        <p className="mt-3 text-[12px] text-muted">
          The answer reaches {who}&rsquo;s handset on its next sync, as a notification and on the
          record itself.
        </p>
      </Modal>
    </>
  );
}
