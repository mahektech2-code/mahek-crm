"use client";

import { useRouter } from "next/navigation";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { useToast } from "@/components/ui/toast";
import type { ImpactConfirmation } from "@/lib/impact/types";
import type { Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * THE IMPACT MODAL FOR AN ERP SCREEN THAT IS NOT A LIST — the Logistics desk,
 * the Quotation manager, a record's panel. A list's actions open it through
 * `erp-ui.tsx`; these screens call their own server actions, so this is the
 * one place their answer is reported the ERP's way: a toast and a refresh when
 * it is done. A refusal stays in the modal, where the person can read it — and
 * a `conflict` reloads the list there instead of closing.
 * ------------------------------------------------------------------------- */

export function ErpImpactDialog({
  kind,
  id,
  confirmLabel,
  onClose,
  act,
  onDone,
  doneMessage,
}: {
  kind: string;
  id: string;
  confirmLabel?: string;
  onClose: () => void;
  /** The write, carrying the confirmation the modal collected. */
  act: (confirmation: ImpactConfirmation) => Promise<Result<unknown>>;
  /** After a write that went through, beyond the toast and the refresh. */
  onDone?: (res: Result<unknown>) => void;
  /** The toast where the write answers with no message of its own. */
  doneMessage?: string;
}) {
  const router = useRouter();
  const { push } = useToast();
  return (
    <ImpactDialog
      key={`${kind}:${id}`}
      kind={kind}
      id={id}
      confirmLabel={confirmLabel}
      onClose={onClose}
      onConfirm={async (confirmation) => {
        const res = await act(confirmation);
        if (res.ok) {
          push(res.message ?? doneMessage ?? "Done");
          onDone?.(res);
          router.refresh();
        }
        return res;
      }}
    />
  );
}
