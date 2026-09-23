"use client";

/* ---------------------------------------------------------------------------
 * A COPY OF A LIST, as a draft of its own.
 *
 * The commonest reason to duplicate is "the same list for another region" or
 * "next month's, before the prices move", so the copy arrives as a DRAFT with
 * a name that cannot be mistaken for the original, and it prices nothing
 * until somebody publishes it.
 *
 * WHO IT APPLIES TO IS NOT COPIED BY DEFAULT. Two published lists naming the
 * same shops at the same level compete for them, and which one wins would
 * then turn on a priority nobody set on purpose. Ticking the box copies them
 * anyway, for the case where the copy is going to replace the original.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Checkbox, Field, Input } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { duplicatePriceList } from "@/lib/actions/price-sheets";
import { copyName } from "@/lib/price-sheet";

export function DuplicateModal({
  list,
  takenNames,
  todayIso,
  basePath,
  onClose,
  onOpenInEditor,
}: {
  list: { id: string; name: string; refNo: string | null; rateCount: number; scopeCount: number };
  takenNames: string[];
  todayIso: string;
  basePath: string;
  onClose: () => void;
  onOpenInEditor: () => void;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [name, setName] = React.useState(copyName(list.name, takenNames));
  const [effectiveFrom, setEffectiveFrom] = React.useState(todayIso);
  const [refNo, setRefNo] = React.useState(list.refNo ?? "");
  const [copyScopes, setCopyScopes] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function go() {
    setBusy(true);
    const r = await run(duplicatePriceList(list.id, { name, effectiveFrom, refNo: refNo.trim() || null, copyScopes }));
    setBusy(false);
    if (r.ok) {
      onClose();
      router.push(`${basePath}/${r.data.id}`);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Duplicate ${list.name}`}
      width={540}
      footer={
        <>
          <Button variant="ghost" onClick={onOpenInEditor} title="Make the copy in the full editor, to change prices before it is saved">
            Open in the editor instead
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void go()} disabled={busy || !name.trim()}>
            {busy ? "Copying…" : "Duplicate"}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-[13px] text-muted">
        Every one of its {list.rateCount} prices, its clauses and its discounts are copied into a new draft. Nothing is
        priced from the copy until it is published.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name of the copy" className="sm:col-span-2">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Effective from">
          <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </Field>
        <Field label="Reference number" hint="Blank prints none.">
          <Input value={refNo} onChange={(e) => setRefNo(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 rounded-[6px] border border-line bg-canvas p-3">
        <Checkbox
          label={`Also copy who it applies to (${list.scopeCount} row${list.scopeCount === 1 ? "" : "s"})`}
          checked={copyScopes}
          disabled={!list.scopeCount}
          onChange={(e) => setCopyScopes(e.target.checked)}
        />
        <p className="mt-1.5 pl-6 text-[12px] text-muted">
          Off by default: two lists naming the same shops compete for them once both are published. Copy them when this
          copy is going to replace the original.
        </p>
      </div>
    </Modal>
  );
}
