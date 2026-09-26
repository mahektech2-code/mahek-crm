"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button, Callout, Textarea } from "@/components/ui/primitives";
import { shortDay } from "@/lib/calling-desk-labels";
import { returnProspectRequest } from "@/lib/actions/lead-calling-desk";
import type { ProspectRequestNotice } from "@/lib/services/lead-calling-desk-service";

/**
 * What the sales manager is told on the existing verification screen when the
 * lead in front of them is a calling-desk REQUEST rather than a Prospect.
 *
 * The verification itself is untouched — same form, same three outcomes. This
 * says what is being verified and why it is different: the lead is still a
 * Suspect, a "Verified" outcome is what makes it a Prospect, and there is one
 * more thing the manager may do that the form has no outcome for — send it back
 * to the desk with a note, which is neither a verification nor a closure.
 */
export function RequestNotice({
  customerId,
  leadName,
  notice,
  reasonLabel,
  canVerify,
}: {
  customerId: string;
  leadName: string;
  notice: ProspectRequestNotice;
  reasonLabel: string | null;
  canVerify: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function send() {
    if (!note.trim()) {
      setError("Say what is wrong — the desk reads this.");
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await returnProspectRequest({ customerId, note });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Sent back to the desk.");
    router.refresh();
  }

  return (
    <div className="px-6 pt-6">
      <Callout tone="brand" className="mb-0 items-start justify-between">
        <div className="text-[13px]">
          <b>A calling-desk request.</b> {notice.requestedByName ?? "The desk"} asked for {leadName} to be put
          forward as a Prospect on {shortDay(notice.requestedAt)}
          {reasonLabel ? ` — ${reasonLabel}` : ""}.{notice.note ? ` “${notice.note}”` : ""} It is still a Suspect:
          recording a <b>Verified</b> outcome below is what makes it a Prospect.
          {notice.state === "followup" ? " It is on hold with you after an earlier follow-up." : ""}
        </div>
        {canVerify ? (
          <Button size="sm" variant="secondary" className="flex-none" onClick={() => setOpen(true)}>
            Return to the Telecaller
          </Button>
        ) : null}
      </Callout>

      {open ? (
        <Modal
          open
          onClose={() => setOpen(false)}
          width={480}
          title={
            <div>
              <div>Return to the Telecaller</div>
              <div className="mt-0.5 text-[13px] font-normal text-muted">
                {leadName} · stays a Suspect, and is not closed
              </div>
            </div>
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void send()}>
                {busy ? "Sending…" : "Send back"}
              </Button>
            </>
          }
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
              What is wrong · required
            </span>
            <Textarea
              rows={4}
              placeholder="The Telecaller reads this, corrects it and resubmits — or closes the lead."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error ? <p className="mt-2 mb-0 text-[13px] text-danger">{error}</p> : null}
        </Modal>
      ) : null}
    </div>
  );
}
