"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import { ConfirmDialog } from "@/components/ui/overlays";
import { closeTaskCampaign, remindTaskCampaign } from "@/lib/actions/sales";

/**
 * Nudge and withdraw. Withdrawing asks first, because it takes work off
 * somebody's phone; reminding does not, because one bell per salesman is the
 * whole of what it does.
 */
export function CampaignActions({ campaignId, open }: { campaignId: string; open: number }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  async function remind() {
    setBusy(true);
    try {
      const r = await remindTaskCampaign(campaignId);
      toast.push(r.ok ? (r.message ?? "Reminded.") : r.error);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    try {
      const r = await closeTaskCampaign(campaignId);
      toast.push(r.ok ? (r.message ?? "Withdrawn.") : r.error);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-2">
      <a href={`/sales/tasks/${campaignId}/export`} className="no-underline">
        <Button>Export answers</Button>
      </a>
      <Button
        disabled={busy || open === 0}
        title={open === 0 ? "Nobody owes an answer." : undefined}
        onClick={() => void remind()}
      >
        Remind who is pending
      </Button>
      <Button
        tone="danger"
        disabled={busy || open === 0}
        title={open === 0 ? "Nothing is still open." : undefined}
        onClick={() => setConfirming(true)}
      >
        Withdraw open tasks
      </Button>
      <ConfirmDialog
        open={confirming}
        title="Withdraw the open tasks?"
        body={`${open} task${open === 1 ? "" : "s"} still open will leave the salesmen's phones. Answers already given are kept.`}
        confirmLabel="Withdraw"
        destructive
        onClose={() => setConfirming(false)}
        onConfirm={withdraw}
      />
    </div>
  );
}
