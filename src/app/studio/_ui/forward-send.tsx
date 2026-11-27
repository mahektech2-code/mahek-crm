"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { sendForwardToRecipients, type ForwardOutcome } from "@/lib/actions/studio-inbox";

/* Sends the uploaded poster through the company WhatsApp number and says, for
   EVERY recipient, what happened: Sent (Kapso took it), Skipped (and why) or
   Failed (and why). The list is this live answer only - nothing is stored per
   recipient - and a recipient outside the 24-hour window is skipped, never sent
   free text. "Sent" is Kapso accepting the message; delivery and read show later
   in the Inbox, from Kapso, and nowhere else. */

const WORD: Record<ForwardOutcome["outcome"], string> = { sent: "Sent", skipped: "Skipped", failed: "Failed" };

export function ForwardSend({ forwardId }: { forwardId: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ForwardOutcome[] | null>(null);
  async function go() {
    setBusy(true);
    setOutcomes(null);
    const res = await toast.run(sendForwardToRecipients(forwardId));
    setBusy(false);
    if (res.ok) setOutcomes(res.data.outcomes);
  }
  return (
    <div>
      <Button variant="primary" onClick={go} disabled={busy} className="h-auto! w-full whitespace-normal! py-2">
        {busy ? "Sending…" : "Send to everyone on WhatsApp (company number)"}
      </Button>
      <p className="mt-1.5 text-[12.5px] text-muted">Sends only to people whose 24-hour WhatsApp window is open. Delivered and Read appear in the Inbox when Kapso reports them.</p>
      {outcomes ? (
        <ul className="mt-2 divide-y divide-divider rounded-control border border-line text-sm" data-testid="forward-outcomes">
          {outcomes.map((o) => (
            <li key={o.recipientId} className="flex flex-wrap gap-x-2 px-3 py-1.5" data-outcome={o.outcome}>
              <span className="font-medium text-ink">{o.name}</span>
              <span className={o.outcome === "sent" ? "text-success" : o.outcome === "failed" ? "text-danger" : "text-muted"}>{WORD[o.outcome]}</span>
              {o.reason ? <span className="text-[12.5px] text-muted">{o.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
