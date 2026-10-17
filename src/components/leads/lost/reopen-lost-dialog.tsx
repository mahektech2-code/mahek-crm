"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button, Textarea } from "@/components/ui/primitives";
import { reopenSalesManagerLead } from "@/lib/actions/lead-reopen";
import { reopenDeskLead } from "@/lib/actions/lead-calling-desk";
import { reopenTarget } from "@/lib/engines/lead-reopen";
import { labelOf, LOST_REASONS, stageLabel } from "@/lib/lead-labels";
import type { LostLeadRow } from "@/lib/services/lead-lost-service";

/** Which door the person holds. Decided on the server — a screen only draws what it was handed. */
export type ReopenSeat = "sales_manager" | "calling_desk";

export type ReopenOffer = {
  seat: ReopenSeat;
  /** `leads.reopenReasons`, read on the server. */
  reasons: { code: string; label: string }[];
};

/**
 * REVERSE A LOST LEAD, from the central list.
 *
 * Only ever drawn for somebody the page found holding one of the two doors, and
 * each door is a different server action that asks its own question again — so
 * a hand-built request from somebody who may only READ this list is refused
 * there, not here. The rung it shows is `reopenTarget`, the same pure rule the
 * server writes with.
 */
export function ReopenLostDialog({
  lead,
  offer,
  onClose,
}: {
  lead: LostLeadRow;
  offer: ReopenOffer;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const needsNote = reason === "other";
  const target = reopenTarget({
    lostFrom: lead.fromStage,
    salesType: lead.salesType,
    lostReason: lead.lostReason,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const input = { customerId: lead.id, reasonCode: reason, note: note.trim() || undefined };
      const result =
        offer.seat === "sales_manager" ? await reopenSalesManagerLead(input) : await reopenDeskLead(input);
      if (!result.ok) {
        setError(result.error);
        router.refresh();
        return;
      }
      toast.push(result.message ?? "Reopened.");
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
      width={480}
      title={
        <div>
          <div>Reverse Lead</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            {lead.name} · the same record comes back; the loss stays in its history
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !reason || (needsNote && !note.trim())} onClick={() => void save()}>
            {busy ? "Saving…" : "Reverse Lead"}
          </Button>
        </>
      }
    >
      <div className="mb-3 rounded-[4px] border border-line px-3 py-2 text-[13px]">
        <div>
          <b>Lost for:</b> {lead.lostReason ? labelOf(LOST_REASONS, lead.lostReason) : "No reason recorded"}
        </div>
        <div className="mt-1">
          <b>Goes back to:</b> {stageLabel(target.stage)}. {target.explains}
        </div>
      </div>
      <div className="mb-1 text-[13px] font-medium text-ink">Why is it being reopened?</div>
      <div className="mb-3 flex flex-col gap-1.5">
        {offer.reasons.map((r) => (
          <label key={r.code} className="flex items-center gap-2 text-[14px]">
            <input type="radio" name="reopen-reason" checked={reason === r.code} onChange={() => setReason(r.code)} />
            {r.label}
          </label>
        ))}
      </div>
      <div className="mb-1 text-[13px] font-medium text-ink">{needsNote ? "Note (required)" : "Note"}</div>
      <Textarea
        rows={3}
        placeholder={needsNote ? "Say what it actually is" : "Optional detail"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

/**
 * REVERSING SEVERAL LOST LEADS AT ONCE - the same act as {@link ReopenLostDialog},
 * once per lead, one after another.
 *
 * There is no second path to "reopen" here: each lead goes through exactly the
 * action a single Reverse goes through (`reopenSalesManagerLead` or
 * `reopenDeskLead`), so its own checks, its own history row and its own
 * notification are the single one's, and the one reason picked is stamped on
 * each. What did not move comes back NAMED with the sentence the server gave,
 * so nobody has to guess which of twelve was refused.
 *
 * Sequential on purpose: each reopen locks and rewrites one lead, and a batch
 * that races itself through one pool is how a partial result becomes
 * unreconstructable.
 */
export function BulkReopenDialog({
  leads,
  offer,
  onClose,
}: {
  leads: LostLeadRow[];
  offer: ReopenOffer;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<Array<{ id: string; name: string; why: string }>>([]);
  const [error, setError] = React.useState<string | null>(null);
  const needsNote = reason === "other";

  async function save() {
    setBusy(true);
    setError(null);
    setFailed([]);
    let done = 0;
    const refused: Array<{ id: string; name: string; why: string }> = [];
    try {
      for (const lead of leads) {
        const input = { customerId: lead.id, reasonCode: reason, note: note.trim() || undefined };
        const result =
          offer.seat === "sales_manager" ? await reopenSalesManagerLead(input) : await reopenDeskLead(input);
        if (result.ok) done += 1;
        else refused.push({ id: lead.id, name: lead.name, why: result.error });
      }
    } catch {
      setError("The request did not reach MahekOne part-way. Refresh to see which leads moved.");
    } finally {
      setBusy(false);
    }
    router.refresh();
    if (!refused.length) {
      toast.push(`${done} ${done === 1 ? "lead" : "leads"} reversed.`);
      onClose();
      return;
    }
    setFailed(refused);
    toast.push(`${done} reversed, ${refused.length} did not move.`);
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={
        <div>
          <div>Reverse {leads.length} {leads.length === 1 ? "lead" : "leads"}</div>
          <div className="mt-0.5 text-[13px] font-normal text-muted">
            Each goes back to the rung it was lost from; the loss stays in its history
          </div>
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {failed.length ? "Close" : "Cancel"}
          </Button>
          {failed.length ? null : (
            <Button disabled={busy || !reason || (needsNote && !note.trim())} onClick={() => void save()}>
              {busy ? "Saving…" : `Reverse ${leads.length}`}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-3 max-h-[120px] overflow-auto rounded-[4px] border border-line px-3 py-2 text-[13px]">
        {leads.map((l) => (
          <div key={l.id} className="truncate">
            {l.name}
            <span className="text-muted"> · {l.lostReason ? labelOf(LOST_REASONS, l.lostReason) : "No reason recorded"}</span>
          </div>
        ))}
      </div>
      <div className="mb-1 text-[13px] font-medium text-ink">Why are they being reopened?</div>
      <div className="mb-3 flex flex-col gap-1.5">
        {offer.reasons.map((r) => (
          <label key={r.code} className="flex items-center gap-2 text-[14px]">
            <input
              type="radio"
              name="bulk-reopen-reason"
              checked={reason === r.code}
              disabled={busy || failed.length > 0}
              onChange={() => setReason(r.code)}
            />
            {r.label}
          </label>
        ))}
      </div>
      <div className="mb-1 text-[13px] font-medium text-ink">{needsNote ? "Note (required)" : "Note"}</div>
      <Textarea
        rows={3}
        placeholder={needsNote ? "Say what it actually is" : "Optional detail, written on every lead"}
        value={note}
        disabled={busy || failed.length > 0}
        onChange={(e) => setNote(e.target.value)}
      />
      {failed.length ? (
        <div className="mt-3 rounded-[4px] border border-line px-3 py-2 text-[13px]">
          <div className="font-medium text-danger">{failed.length} did not move</div>
          {failed.map((f) => (
            <div key={f.id} className="mt-1">
              <b>{f.name}</b> - {f.why}
            </div>
          ))}
        </div>
      ) : null}
      {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}
