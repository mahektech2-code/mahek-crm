"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import { assignDeskLead } from "@/lib/actions/lead-desk-assignment";

export type Assignee = { id: string; name: string };

/**
 * REASSIGN — hand this lead to another Telecaller.
 *
 * It is `assignDeskLead`, the desk's own assignment, and nothing else: the
 * picker offers people who hold the Calling desk (a lead given to anybody else
 * would vanish into a book they cannot read), it changes who OWNS the lead and
 * the next action that was the old owner's, and it leaves untouched who RAISED
 * the lead — that is the append-only creation history, drawn beside this control
 * as "Created by".
 *
 * There used to be no way to do this from the record at all: the button lived on
 * the desk's own screen, and the list's "Reassign" offered only people holding
 * the Salesman App. A manager reading a lead that was with the wrong person had
 * to go and find another screen.
 *
 * Drawn disabled, with the reason, for anybody who cannot do it — the same two
 * questions the action asks (`lead.verify`, and the desk). A disabled button is
 * a fact about a component; the action asks again.
 */
export function ReassignLead({
  customerId,
  name,
  currentId,
  currentName,
  assignees,
  canReassign,
}: {
  customerId: string;
  name: string;
  currentId: string | null;
  currentName: string | null;
  assignees: Assignee[];
  canReassign: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const others = assignees.filter((a) => a.id !== currentId);

  function begin() {
    setChosen(others[0]?.id ?? "");
    setError(null);
    setOpen(true);
  }

  async function submit() {
    if (!chosen) {
      setError("Pick who it goes to.");
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await assignDeskLead({ customerId, ownerId: chosen });
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    toast.push(result.message ?? "Reassigned.");
    router.refresh();
  }

  return (
    <>
      <Button
        size="sm"
        tone="quiet"
        disabled={!canReassign}
        title={
          canReassign
            ? "Hand this lead to another Telecaller."
            : "Handing a lead to another Telecaller is a manager's, on the Calling desk. Yours is not one of the hats that carries it."
        }
        onClick={begin}
      >
        Reassign
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Reassign the lead" width={480}>
        <p className="mb-3 text-[13px] text-body">
          {name} · <span className="font-medium text-ink">{currentName ?? "Unassigned"}</span>
        </p>
        <p className="mb-3 text-[13px] text-pretty text-body">
          The new owner works it from their Calling desk. A next action that was the old owner&rsquo;s
          goes with it; one owed by the Sales Manager stays with the Sales Manager. Who raised the
          lead does not change.
        </p>
        {others.length === 0 ? (
          <p className="text-[13px] text-pretty text-warn-ink">
            Nobody else holds the Calling desk. Grant it on the Access screen first.
          </p>
        ) : (
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">Move it to</span>
            <select
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
            >
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button tone="quiet" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy || !chosen || others.length === 0} onClick={() => void submit()}>
            {busy ? "Saving…" : "Reassign"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
