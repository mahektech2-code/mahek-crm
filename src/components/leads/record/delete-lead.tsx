"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import { trashLeads } from "@/lib/actions/lead-trash";

/**
 * DELETE THIS LEAD — move it to the trash, from its own record.
 *
 * A manager's (`lead.trash`), with a reason, because whoever opens the trash
 * has to know why a lead is there before deciding whether it comes back. The
 * record then has nothing left to show, so the screen goes back to the list.
 * Not destructive: an administrator restores it from the Admin Console's
 * Trash with its whole history.
 */
export function DeleteLead({
  customerId,
  name,
  canTrash,
  backHref,
}: {
  customerId: string;
  name: string;
  canTrash: boolean;
  /** Where to go once it has left: the leads list this record was opened from. */
  backHref: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (reason.trim().length < 3) {
      setError("Say why — it is shown to whoever looks in the trash.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await trashLeads({ ids: [customerId], reason });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOpen(false);
      toast.push(r.message ?? `${name} moved to the trash.`);
      router.push(backHref);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        tone="danger"
        size="sm"
        disabled={!canTrash}
        title={
          canTrash
            ? "Off every screen until an administrator restores it from the Admin Console's Deleted leads."
            : "Deleting a lead is a manager's. Yours is not one of the hats that carries it."
        }
        onClick={() => {
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        Delete
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete this lead" width={460}>
        <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px] font-medium text-ink">
          {name}
        </div>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Why · required</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="e.g. Duplicate of another lead, test entry, not a real business"
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
        <p className="mt-2 text-[12px] text-muted">
          It leaves every screen — the lists, the calling queue, search, reports and the salesmen&rsquo;s
          phones. Nothing is lost: an administrator can restore it from the Admin Console&rsquo;s Deleted leads,
          with its owner, stage and every call and note.
        </p>
        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button tone="danger" disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>
            {busy ? "Moving…" : "Move to trash"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
