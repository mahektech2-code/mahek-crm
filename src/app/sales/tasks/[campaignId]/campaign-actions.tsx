"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { closeTaskCampaign, remindTaskCampaign } from "@/lib/actions/sales";

/**
 * Nudge and withdraw. Withdrawing asks first — through the impact modal, which
 * names whose phones the open tasks leave and keeps the answers already given —
 * because it takes work off somebody's phone; reminding does not, because one
 * bell per salesman is the whole of what it does.
 */
export function CampaignActions({ campaignId, open }: { campaignId: string; open: number }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState<number | null>(null);

  async function remind() {
    setBusy(true);
    try {
      const r = await remindTaskCampaign(campaignId);
      toast.push(r.ok ? (r.message ?? "Reminded.") : r.error);
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
        onClick={() => setConfirming(Date.now())}
      >
        Withdraw open tasks
      </Button>
      {confirming !== null ? (
        <ImpactDialog
          key={confirming}
          kind="sales-task-campaign-withdraw"
          id={campaignId}
          confirmLabel="Withdraw open tasks"
          onClose={() => setConfirming(null)}
          onConfirm={async (confirmation) => {
            setBusy(true);
            try {
              const r = await closeTaskCampaign(campaignId, confirmation);
              if (r.ok) {
                toast.push(r.message ?? "Withdrawn.");
                router.refresh();
              }
              return r;
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}
