"use client";

/* ---------------------------------------------------------------------------
 * THE NEXT VERSION OF A LIST — a draft copy of everything, to change.
 *
 * A list in force is not edited, because orders have been taken against it.
 * The way forward is a new version: the same rates, the same scopes, the same
 * terms, as a DRAFT, with a new effective date. Change what has moved, then
 * publish it — and publishing supersedes the one it came from.
 *
 * The name and the reference default to the old ones rather than being blanked
 * — most revisions keep the name and gain a date, and a form that empties two
 * fields somebody has to retype is a form that gets half filled in.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Button, Field, Input } from "@/components/ui/primitives";
import { newVersion } from "@/lib/actions/price-lists";

const DATE_CLASS =
  "h-8.5 rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand";

export function NewVersionModal(props: {
  open: boolean;
  onClose: () => void;
  listId: string;
  listName: string;
  refNo: string | null;
  version: number;
  todayIso: string;
  basePath: string;
}) {
  if (!props.open) return null;
  return <NewVersionBody key={props.listId} {...props} />;
}

function NewVersionBody({
  onClose,
  listId,
  listName,
  refNo,
  version,
  todayIso,
  basePath,
}: {
  onClose: () => void;
  listId: string;
  listName: string;
  refNo: string | null;
  version: number;
  todayIso: string;
  basePath: string;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [name, setName] = React.useState(listName);
  const [ref, setRef] = React.useState(refNo ?? "");
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso);

  async function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setErrors({ effectiveFrom: "Say when the new version comes into force." });
      return;
    }
    setBusy(true);
    try {
      const r = await run(
        newVersion(listId, { effectiveFrom, name: name.trim() || undefined, refNo: ref.trim() || null }),
      );
      if (r.ok) {
        onClose();
        router.push(`${basePath}/${r.data.id}`);
      } else if (r.fieldErrors) {
        setErrors(Object.fromEntries(r.fieldErrors.map((f) => [f.field, f.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Version ${version + 1} of ${listName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save} title={busy ? "Copying…" : undefined}>
            {busy ? "Copying…" : "Make the draft"}
          </Button>
        </>
      }
    >
      <p className="mb-3.5 max-w-[720px] text-[13px] text-muted">
        Every price, every discount and everybody named on it comes across as a
        draft. Change what has moved, then publish — publishing supersedes the
        version it came from.
      </p>
      <div className="space-y-3.5">
        <Field label="Name" error={errors.name ?? null}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Reference number" error={errors.refNo ?? null}>
          <Input value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Field label="Effective from" error={errors.effectiveFrom ?? null}>
          <input
            type="date"
            className={DATE_CLASS}
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
