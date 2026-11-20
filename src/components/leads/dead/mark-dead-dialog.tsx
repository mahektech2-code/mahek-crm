"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button, Textarea } from "@/components/ui/primitives";
import { actingForLead } from "@/lib/actions/lead-manager-authority";
import { previewDeadApprover, requestDeadLead, type DeadDialogFacts } from "@/lib/actions/lead-dead";

/**
 * MARK A LOST LEAD AS DEAD — the one dialog every menu opens.
 *
 * It names the approver BEFORE anything is sent (read from the Org Chart on the
 * server when the dialog opens) and says in words that approval locks the lead
 * for good. A request the Org Chart cannot route is not offered at all: the
 * sentence says an administrator has to correct it, and Send stays disabled.
 * Eligibility is not decided here — the menu that opens this only draws it for
 * a Lost lead, and `requestDeadLead` refuses anything else.
 */
export function MarkDeadDialog({
  lead,
  onClose,
}: {
  lead: { id: string; name: string };
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [facts, setFacts] = React.useState<DeadDialogFacts | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [actingFor, setActingFor] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    actingForLead(lead.id)
      .then((r) => {
        if (live && r.ok) setActingFor(r.data?.ownerName ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lead.id]);

  React.useEffect(() => {
    let live = true;
    previewDeadApprover()
      .then((r) => {
        if (!live) return;
        if (r.ok) setFacts(r.data);
        else setLoadError(r.error);
      })
      .catch(() => {
        if (live) setLoadError("Could not reach MahekOne to find your reporting manager. Try again.");
      });
    return () => {
      live = false;
    };
  }, []);

  const needsNote = reason === "other";
  const canSend = Boolean(facts?.approverName) && Boolean(reason) && (!needsNote || Boolean(note.trim()));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestDeadLead({ customerId: lead.id, reasonCode: reason, note: note.trim() || undefined });
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      toast.push(result.message ?? "Sent for approval.");
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
      width={500}
      title={
        <div>
          <div>Mark as Dead</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">{lead.name}</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !canSend} onClick={() => void send()}>
            {busy ? "Sending…" : "Send for approval"}
          </Button>
        </>
      }
    >
      <div className="mb-3 rounded-[4px] border border-danger bg-danger-soft px-3 py-2 text-[13px] text-body">
        <b className="text-danger">This is permanent.</b> If your reporting manager approves, this lead is locked for
        good: it can be viewed, but it can never be reopened, reassigned, edited, called, visited, ordered against or
        converted. Nothing is deleted — its history stays readable. Until then it stays Lost and nothing changes.
      </div>

      {actingFor ? (
        <p className="mb-3 rounded-[4px] border border-info bg-info-soft px-3 py-2 text-[13px] text-body" data-testid="acting-marker">
          <b className="text-ink">Acting on behalf of {actingFor}</b>, who has left. It is recorded under your own name; the
          lead is not transferred.
        </p>
      ) : null}
      {loadError ? (
        <p className="mb-3 text-[13px] text-danger">{loadError}</p>
      ) : !facts ? (
        <p className="mb-3 text-[13px] text-muted">Finding your reporting manager…</p>
      ) : facts.approverName ? (
        <p className="mb-3 text-[13px] text-body">
          Goes to <b className="text-ink">{facts.approverName}</b> only — your reporting manager on the Org Chart. Nobody
          else is asked.
        </p>
      ) : (
        <p className="mb-3 text-[13px] text-danger">{facts.blocked}</p>
      )}

      {facts?.approverName ? (
        <>
          <div className="mb-1 text-[13px] font-medium text-ink">Why is it Dead?</div>
          <div className="mb-3 flex flex-col gap-1.5">
            {facts.reasons.map((r) => (
              <label key={r.code} className="flex items-center gap-2 text-[14px]">
                <input type="radio" name="dead-reason" checked={reason === r.code} onChange={() => setReason(r.code)} />
                {r.label}
              </label>
            ))}
          </div>
          <div className="mb-1 text-[13px] font-medium text-ink">{needsNote ? "Note (required)" : "Note (optional)"}</div>
          <Textarea
            rows={3}
            placeholder={needsNote ? "Say what it actually is" : "Anything your manager should know"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </>
      ) : null}
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}
