"use client";

import * as React from "react";
import { Button, Input } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { sendTestAction } from "@/lib/actions/whatsapp-founder";
import type { MessagePreview } from "@/lib/services/whatsapp-service";

/**
 * Exactly what one customer would receive from one template — or every reason
 * they would not — and a way to send that exact message to your OWN phone.
 *
 * One component for both places the founder asks the question: "Try it on a
 * customer" on the Setup tab, and a rule's panel on the Automation tab. Two
 * copies of the bubble and the test send would drift, and the one that drifted
 * would be the one somebody trusted before switching a rule to Live.
 */
export function MessagePreviewView({
  preview,
  customerId,
  customerName,
  templateId,
  linked,
  defaultPhone = "",
}: {
  preview: MessagePreview;
  customerId: string;
  customerName: string;
  templateId: string;
  /** Linked to an approved Wati template — a test send needs one. */
  linked: boolean;
  defaultPhone?: string;
}) {
  const { run } = useToast();
  const [phone, setPhone] = React.useState(defaultPhone);
  const [busy, setBusy] = React.useState(false);

  if (!preview.ok) {
    return (
      <div className="rounded-[6px] border border-danger-soft bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
        <span className="block font-medium">{customerName} would NOT be sent this:</span>
        {preview.reasons.map((r) => (
          <span key={r} className="mt-1 block">{r}</span>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="mb-1 text-[13px] text-muted">
        {preview.route === "automatic"
          ? "Would go through the API, with its buttons:"
          : `Would be copied and pasted — ${preview.manualWhy ?? ""}`}
      </div>
      <div className="rounded-[6px] border border-brand-softer bg-brand-soft px-3 py-2.5 text-[14px] leading-[21px] whitespace-pre-wrap text-ink">
        {preview.body}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Input value={phone} placeholder="Your WhatsApp number" onChange={(e) => setPhone(e.target.value)} />
        <Button
          variant="secondary"
          disabled={busy || !phone.trim() || !linked}
          title={linked ? undefined : "Link this template to its approved Wati template first (Setup tab)"}
          onClick={async () => {
            setBusy(true);
            try {
              await run(sendTestAction(customerId, templateId, phone));
            } finally {
              setBusy(false);
            }
          }}
        >
          Send test to me
        </Button>
      </div>
      <p className="mt-1.5 text-[12px] text-muted">
        {linked
          ? "Sends this exact message to the number you type — never to the customer. Works even while sending is switched off."
          : "A test send needs this template linked to its approved Wati template — do that on the Setup tab."}
      </p>
    </>
  );
}
