"use client";

/* ---------------------------------------------------------------------------
 * TURNING A DOCUMENT DOWN, with the reason written down.
 *
 * The same rule as a lost lead and a declined order: nobody will look at this
 * file again, so the sentence saying why is the only thing standing between it
 * and being uploaded a second time next week. The action demands one too — a
 * check that lives in a dialog is not a check.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Textarea } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { rejectDocument } from "@/lib/actions/price-lists";

export function RejectDocumentModal({
  open,
  onClose,
  documentId,
  filename,
}: {
  open: boolean;
  onClose: () => void;
  documentId: string;
  filename: string;
}) {
  if (!open) return null;
  return <Body key={documentId} onClose={onClose} documentId={documentId} filename={filename} />;
}

function Body({
  onClose,
  documentId,
  filename,
}: {
  onClose: () => void;
  documentId: string;
  filename: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  async function save() {
    if (!reason.trim()) {
      setErrors({ reason: "Say why, so the next person does not upload it again." });
      return;
    }
    setBusy(true);
    try {
      const result = await run(rejectDocument(documentId, reason.trim()));
      if (result.ok) {
        onClose();
        router.refresh();
      } else if (result.fieldErrors) {
        setErrors(Object.fromEntries(result.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Reject this document"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void save()}>
            {busy ? "Rejecting…" : "Reject"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        {filename} stays on record with your reason against it. It becomes no price list and nothing is
        deleted.
      </p>
      <Field label="Why" error={errors.reason ?? null}>
        <Textarea
          rows={3}
          value={reason}
          invalid={!!errors.reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="A photograph of a delivery note, not a price list."
        />
      </Field>
    </Modal>
  );
}
