"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button, Textarea } from "@/components/ui/primitives";
import { previewDeadApprover, requestDeadLeads, type BulkDeadResult, type DeadDialogFacts } from "@/lib/actions/lead-dead";

/**
 * MARK SEVERAL LOST LEADS AS DEAD — every selected lead goes for approval.
 *
 * The same act as {@link MarkDeadDialog}, once per lead, with one reason and one
 * note stamped on all of them. It names the approver BEFORE anything is sent
 * (the same Org Chart read the single dialog makes) and says in words that each
 * lead is decided on its own. What was not sent comes back NAMED with the
 * sentence the single action would have given — a lead that is not Lost, is
 * already Dead, or already has a request waiting — so nobody has to guess which
 * of fifteen was left out, and the rest still went.
 *
 * Eligibility is not decided here: the server asks again for every lead.
 */
export function BulkMarkDeadDialog({
  leads,
  onClose,
  onSent,
}: {
  leads: Array<{ id: string; name: string }>;
  onClose: () => void;
  /** Called once the requests are in, so the screen can clear its ticks. */
  onSent?: (result: BulkDeadResult) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [facts, setFacts] = React.useState<DeadDialogFacts | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<BulkDeadResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
  const canSend = !result && Boolean(facts?.approverName) && Boolean(reason) && (!needsNote || Boolean(note.trim()));
  const n = leads.length;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await requestDeadLeads({
        customerIds: leads.map((l) => l.id),
        reasonCode: reason,
        note: note.trim() || undefined,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setResult(r.data);
      router.refresh();
      onSent?.(r.data);
      if (!r.data.refused.length) {
        toast.push(r.message ?? "Sent for approval.");
        onClose();
        return;
      }
      toast.push(r.message ?? "Some were not sent.");
    } catch {
      setError("The request did not reach MahekOne. Refresh to see which leads were sent.");
      router.refresh();
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
          <div>
            Mark {n} {n === 1 ? "lead" : "leads"} as Dead
          </div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">Every selected lead goes for approval</div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {result ? null : (
            <Button disabled={busy || !canSend} onClick={() => void send()}>
              {busy ? "Sending…" : `Send ${n} for approval`}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-3 rounded-[4px] border border-danger bg-danger-soft px-3 py-2 text-[13px] text-body">
        <b className="text-danger">This is permanent.</b> For each lead your reporting manager approves, that lead is
        locked for good: it can be viewed, but never reopened, reassigned, edited, called, visited, ordered against or
        converted. Until then it stays Lost and nothing changes.
      </div>

      <div className="mb-3 max-h-[120px] overflow-auto rounded-[4px] border border-line px-3 py-2 text-[13px]">
        {leads.map((l) => (
          <div key={l.id} className="truncate">
            {l.name}
          </div>
        ))}
      </div>

      {loadError ? (
        <p className="mb-3 text-[13px] text-danger">{loadError}</p>
      ) : !facts ? (
        <p className="mb-3 text-[13px] text-muted">Finding your reporting manager…</p>
      ) : facts.approverName ? (
        <p className="mb-3 text-[13px] text-body">
          Goes to <b className="text-ink">{facts.approverName}</b> only — your reporting manager on the Org Chart. Each
          lead is a request of its own, approved or rejected on its own.
        </p>
      ) : (
        <p className="mb-3 text-[13px] text-danger">{facts.blocked}</p>
      )}

      {facts?.approverName && !result ? (
        <>
          <div className="mb-1 text-[13px] font-medium text-ink">Why are they Dead?</div>
          <div className="mb-3 flex flex-col gap-1.5">
            {facts.reasons.map((r) => (
              <label key={r.code} className="flex items-center gap-2 text-[14px]">
                <input
                  type="radio"
                  name="bulk-dead-reason"
                  checked={reason === r.code}
                  disabled={busy}
                  onChange={() => setReason(r.code)}
                />
                {r.label}
              </label>
            ))}
          </div>
          <div className="mb-1 text-[13px] font-medium text-ink">{needsNote ? "Note (required)" : "Note (optional)"}</div>
          <Textarea
            rows={3}
            placeholder={needsNote ? "Say what it actually is" : "Optional detail, written on every request"}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
        </>
      ) : null}

      {result ? (
        <div className="mt-1 rounded-[4px] border border-line px-3 py-2 text-[13px]" data-testid="bulk-dead-result">
          <div className="font-medium text-ink">
            {result.requested} sent to {result.approverName ?? "your manager"} for approval
          </div>
          {result.refused.length ? (
            <>
              <div className="mt-2 font-medium text-danger">{result.refused.length} not sent</div>
              {result.refused.map((f) => (
                <div key={f.id} className="mt-1">
                  <b>{f.name}</b> — {f.why}
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}
