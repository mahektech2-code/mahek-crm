"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button, Textarea } from "@/components/ui/primitives";
import { decideDeadRequest } from "@/lib/actions/lead-dead";
import { labelOf } from "@/lib/lead-labels";
import { DEAD_REASONS } from "@/lib/lead-dead";

/** The few things the dialog needs to say about the request. Serialisable. */
export type DecidableRequest = {
  id: string;
  leadName: string;
  requestedByName: string | null;
  reasonCode: string;
  note: string | null;
  lostReasonAtRequest: string | null;
};

/**
 * APPROVE OR REJECT A DEAD REQUEST — the assigned manager's decision.
 *
 * Approval is irreversible, so it needs a ticked confirmation that is sent to
 * the server and checked there; a rejection needs a reason, which the
 * requester is shown. Whether THIS person may decide is not asked here: the
 * server checks the request names them as its approver, and only draws this
 * dialog's entry points for them anyway.
 */
export function DecideDeadDialog({
  request,
  reasons,
  onClose,
}: {
  request: DecidableRequest;
  /** `leads.deadReasons`, so the label reads as configured. */
  reasons?: { code: string; label: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = React.useState<"approve" | "reject">("approve");
  const [confirmed, setConfirmed] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reasonLabel = labelOf(reasons ?? DEAD_REASONS, request.reasonCode);
  const ready = mode === "approve" ? confirmed : Boolean(note.trim());

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await decideDeadRequest({
        requestId: request.id,
        approve: mode === "approve",
        note: note.trim() || undefined,
        confirmed: mode === "approve" ? confirmed : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      toast.push(result.message ?? "Decided.");
      router.refresh();
      onClose();
    } catch {
      setError("The request did not reach MahekOne. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={
        <div>
          <div>Dead request</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{request.leadName}</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !ready} onClick={() => void save()}>
            {busy ? "Saving…" : mode === "approve" ? "Approve — make it Dead" : "Reject the request"}
          </Button>
        </>
      }
    >
      <div className="mb-3 rounded-[4px] border border-line px-3 py-2 text-[13px]">
        <div>
          <b>Asked by:</b> {request.requestedByName ?? "Not recorded"}
        </div>
        <div className="mt-1">
          <b>Why it is Dead:</b> {reasonLabel}
          {request.note ? ` — ${request.note}` : ""}
        </div>
        <div className="mt-1">
          <b>Lost for:</b> {request.lostReasonAtRequest ?? "No reason recorded"}
        </div>
      </div>

      <div className="mb-3 flex gap-4 text-[14px]">
        <label className="flex items-center gap-2">
          <input type="radio" name="dead-decision" checked={mode === "approve"} onChange={() => setMode("approve")} />
          Approve
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="dead-decision" checked={mode === "reject"} onChange={() => setMode("reject")} />
          Reject
        </label>
      </div>

      {mode === "approve" ? (
        <label className="flex items-start gap-2 rounded-[4px] border border-danger bg-danger-soft px-3 py-2 text-[13px] text-body">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            I understand that approving makes this lead <b>permanently Dead and read-only</b>. It can never be reopened,
            reassigned, edited, called, visited, ordered against or converted. Its history stays readable.
          </span>
        </label>
      ) : (
        <>
          <div className="mb-1 text-[13px] font-medium text-ink">Why are you rejecting it? (required)</div>
          <Textarea
            rows={3}
            placeholder="The person who asked is shown this. The lead stays Lost and they can ask again."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </>
      )}
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}
