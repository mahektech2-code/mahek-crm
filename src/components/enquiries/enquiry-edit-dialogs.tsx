"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { useToast } from "@/components/ui/toast";
import { today } from "@/lib/format";
import {
  ENQUIRY_PRIORITIES,
  MANUAL_ENQUIRY_SOURCES,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  type EnquiryPriority,
} from "@/lib/enquiry-labels";
import type { EnquirySubmissionFields } from "@/lib/enquiry-submission";
import {
  correctEnquiryDetailsAction,
  createManualEnquiryAction,
  editEnquiryNoteAction,
  rescheduleEnquiryReminderAction,
} from "@/lib/actions/enquiries";
import type { ImpactConfirmation } from "@/lib/impact/types";
import type { Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * The enquiry desk's edits, each a Modal, and its removals, each the reason
 * first and then the impact dialog. Every dialog here is mounted only while
 * open and keyed by its caller, so it starts with the record's current values
 * rather than resetting state in an effect.
 * ------------------------------------------------------------------------- */

type FieldErrors = Record<string, string>;

function fieldErrors(r: Result<unknown>): FieldErrors {
  if (r.ok || !r.fieldErrors) return {};
  return Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message]));
}

/* ------------------------------------------------------ new enquiry */

export function NewEnquiryButton() {
  const [open, setOpen] = React.useState(0);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(Date.now())}>
        New enquiry
      </Button>
      {open ? <NewEnquiryDialog key={open} onClose={() => setOpen(0)} /> : null}
    </>
  );
}

function NewEnquiryDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { run } = useToast();
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [company, setCompany] = React.useState("");
  const [requirement, setRequirement] = React.useState("");
  const [source, setSource] = React.useState<string>("");
  const [priority, setPriority] = React.useState<EnquiryPriority>("normal");
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});

  async function save() {
    setBusy(true);
    try {
      const r = await run(createManualEnquiryAction({ name, phone, email, company, requirement, source, priority }));
      if (r.ok) {
        onClose();
        router.push(`/enquiries/list/${r.data.id}`);
      } else setErrors(fieldErrors(r));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New enquiry"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={busy || !name.trim() || !source || (!phone.trim() && !email.trim())}
            title={!name.trim() ? "Say who it is from" : !source ? "Pick where it came from" : !phone.trim() && !email.trim() ? "Give a phone number or an email" : undefined}
          >
            {busy ? "Saving…" : "Add enquiry"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        For an enquiry that reached somebody by phone, at the counter or on another channel. Website enquiries arrive on their own.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required error={errors.name} className="col-span-2">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} invalid={!!errors.name} />
        </Field>
        <Field label="Phone" error={errors.phone}>
          <Input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} invalid={!!errors.phone} />
        </Field>
        <Field label="Email" optional>
          <Input value={email} type="email" onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Company" optional className="col-span-2">
          <Input value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label="Came from" required error={errors.source}>
          <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-full">
            <option value="">Choose…</option>
            {MANUAL_ENQUIRY_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as EnquiryPriority)} className="w-full">
            {ENQUIRY_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Requirement" optional className="col-span-2">
          <Textarea value={requirement} onChange={(e) => setRequirement(e.target.value)} className="h-20 w-full" placeholder="What they asked for, in their words" />
        </Field>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------- correct details */

export function EditDetailsDialog({
  enquiryId,
  current,
  onClose,
}: {
  enquiryId: string;
  current: EnquirySubmissionFields;
  onClose: () => void;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [name, setName] = React.useState(current.name ?? "");
  const [phone, setPhone] = React.useState(current.phone ?? "");
  const [email, setEmail] = React.useState(current.email ?? "");
  const [company, setCompany] = React.useState(current.company ?? "");
  const [message, setMessage] = React.useState(current.message ?? "");
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors>({});

  async function save() {
    setBusy(true);
    try {
      const r = await run(correctEnquiryDetailsAction(enquiryId, { name, phone, email, company, message }));
      if (r.ok) {
        onClose();
        router.refresh();
      } else setErrors(fieldErrors(r));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Correct the details"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !name.trim()} title={!name.trim() ? "An enquiry needs a name" : undefined}>
            {busy ? "Saving…" : "Save corrections"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        What was submitted is kept as it arrived. Your corrections are read over it, and the activity records what each field said before.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" required error={errors.name} className="col-span-2">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} invalid={!!errors.name} />
        </Field>
        <Field label="Phone" error={errors.phone}>
          <Input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} invalid={!!errors.phone} />
        </Field>
        <Field label="Email" optional>
          <Input value={email} type="email" onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Company" optional className="col-span-2">
          <Input value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label="Requirement" optional className="col-span-2">
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} className="h-24 w-full" />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ a note */

export function EditNoteDialog({
  enquiryId,
  activityId,
  note,
  onClose,
}: {
  enquiryId: string;
  activityId: string;
  note: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [text, setText] = React.useState(note);
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await run(editEnquiryNoteAction(enquiryId, activityId, text));
      if (r.ok) {
        onClose();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit your note"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !text.trim()} title={!text.trim() ? "Write something, or delete the note instead" : undefined}>
            {busy ? "Saving…" : "Save note"}
          </Button>
        </>
      }
    >
      <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} className="h-28 w-full" />
      <p className="mt-2 text-[13px] text-muted">The note is marked as edited, and what it said before is kept on it.</p>
    </Modal>
  );
}

/* ------------------------------------------------------- a follow-up */

export function RescheduleDialog({
  enquiryId,
  reminderId,
  dueDate,
  note,
  onClose,
}: {
  enquiryId: string;
  reminderId: string;
  dueDate: string;
  note: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [date, setDate] = React.useState(dueDate < today() ? today() : dueDate);
  const [text, setText] = React.useState(note);
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await run(rescheduleEnquiryReminderAction(enquiryId, reminderId, date, text !== note ? text : undefined));
      if (r.ok) {
        onClose();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Move this follow-up"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !date || date === dueDate && text === note} title={date === dueDate && text === note ? "Pick a different date" : undefined}>
            {busy ? "Saving…" : "Move it"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="New date" hint="A holiday or a day off moves to the next working day.">
          <Input type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Note" optional>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} className="h-16 w-full" />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------- reason first, then the impact */

/**
 * The house runner for a removal that carries a reason: the reason is asked
 * in a plain Modal, then the impact dialog says what goes and takes the typed
 * confirmation, and the act receives both.
 */
export function ReasonThenImpact({
  title,
  sub,
  reasonLabel,
  reasonRequired,
  impact,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  sub: string;
  reasonLabel: string;
  reasonRequired: boolean;
  impact: { kind: string; id: string };
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: (reason: string, confirmation: ImpactConfirmation) => Promise<Result<unknown>>;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [reason, setReason] = React.useState("");
  const [step, setStep] = React.useState<"reason" | "impact">("reason");

  if (step === "impact") {
    return (
      <ImpactDialog
        kind={impact.kind}
        id={impact.id}
        confirmLabel={confirmLabel}
        onClose={onClose}
        onConfirm={async (confirmation) => {
          const r = await onConfirm(reason, confirmation);
          if (r.ok) {
            push(r.message ?? "Done.");
            router.refresh();
          }
          return r;
        }}
      />
    );
  }

  const missing = reasonRequired && !reason.trim();
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => setStep("impact")} disabled={missing} title={missing ? "Give a reason first" : undefined}>
            Continue
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">{sub}</p>
      <Field label={reasonLabel} required={reasonRequired} optional={!reasonRequired}>
        <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className="h-20 w-full" />
      </Field>
    </Modal>
  );
}
