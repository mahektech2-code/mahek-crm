"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { btnClass } from "../_shell/kit";
import { restoreAnnouncementAction, restoreDocument, restoreFile } from "@/lib/actions/admin-console";

const RUN = { file: restoreFile, document: restoreDocument, announcement: restoreAnnouncementAction } as const;

/** Restore one item from the recycle bin, through the action for its kind. */
export function BinRestoreButton({ kind, id, name }: { kind: keyof typeof RUN; id: string; name: string }) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className={`${btnClass("plain", "sm")} h-8`}
      disabled={busy}
      aria-label={`Restore ${name}`}
      onClick={async () => {
        setBusy(true);
        const r = await RUN[kind](id);
        setBusy(false);
        notify(r.ok ? (r.message ?? "Restored.") : r.error, r.ok ? "info" : "error");
        if (r.ok) router.refresh();
      }}
    >
      {busy ? "Restoring…" : "Restore"}
    </button>
  );
}
