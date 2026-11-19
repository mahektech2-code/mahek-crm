"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/console/parts";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { Modal } from "@/components/ui/modal";
import { Button as UiButton, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { closeTaskCampaign, editTaskCampaign, remindTaskCampaign } from "@/lib/actions/sales";
import { plural } from "@/components/console/words";

type Current = { title: string; description: string; priority: string; dueDate: string };

/**
 * Edit, nudge and withdraw. Withdrawing asks first — through the impact modal,
 * which names whose phones the open tasks leave and keeps the answers already
 * given — because it takes work off somebody's phone; reminding does not,
 * because one bell per salesman is the whole of what it does. Editing says,
 * before it saves, which tasks it reaches and which it leaves alone.
 */
export function CampaignActions({
  campaignId,
  open,
  answered,
  closed,
  current,
}: {
  campaignId: string;
  open: number;
  /** Tasks already answered — they keep the wording they were answered under. */
  answered: number;
  closed: boolean;
  current: Current;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState(false);

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
        disabled={busy || closed}
        title={closed ? "This assignment was withdrawn." : "Correct the title, description, priority or due date."}
        onClick={() => setEditing(true)}
      >
        Edit
      </Button>
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
      {editing ? (
        <EditCampaignModal
          campaignId={campaignId}
          current={current}
          open={open}
          answered={answered}
          onClose={() => setEditing(false)}
          onSaved={(message) => {
            setEditing(false);
            toast.push(message);
            router.refresh();
          }}
        />
      ) : null}
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

const PRIORITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function EditCampaignModal({
  campaignId,
  current,
  open,
  answered,
  onClose,
  onSaved,
}: {
  campaignId: string;
  current: Current;
  open: number;
  answered: number;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [title, setTitle] = React.useState(current.title);
  const [description, setDescription] = React.useState(current.description);
  const [priority, setPriority] = React.useState(current.priority);
  const [dueDate, setDueDate] = React.useState(current.dueDate);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dateMoved = dueDate !== current.dueDate;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await editTaskCampaign({ campaignId, title, description, priority, dueDate });
      if (!r.ok) return setError(r.error);
      onSaved(r.message ?? "Updated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit assignment"
      width={560}
      footer={
        <>
          <UiButton variant="secondary" onClick={onClose}>
            Cancel
          </UiButton>
          <UiButton
            variant="primary"
            disabled={busy || title.trim().length < 3 || !dueDate}
            title={title.trim().length < 3 ? "A task needs a real title." : !dueDate ? "Pick a due date." : undefined}
            onClick={() => void save()}
          >
            Save changes
          </UiButton>
        </>
      }
    >
      <Field label="Title" required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Description" optional className="mt-3">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </Field>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due by" required>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
      {/* What an edit does to work already handed out, said before saving. */}
      <div className="mt-3 rounded-[4px] border border-line bg-canvas px-3 py-2 text-[13px] leading-[19px] text-body">
        {open
          ? `${plural(open, "open task")} on the phones change${open === 1 ? "s" : ""} with it on the next sync.`
          : "No task is still open, so nothing on the phones changes."}
        {answered ? ` ${plural(answered, "answered task")} keep${answered === 1 ? "s" : ""} the wording it was answered under.` : ""}
        {dateMoved && open ? " Each salesman with an open task gets one bell saying the date moved." : ""}
        {" "}Who it goes to and the questions are not changed here — withdraw and assign again for that.
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}
