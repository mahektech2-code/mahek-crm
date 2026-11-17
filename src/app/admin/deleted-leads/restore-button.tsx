"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { restoreAnnouncementAction, restoreDocument, restoreFile } from "@/lib/actions/admin-console";

const RUN = { file: restoreFile, document: restoreDocument, announcement: restoreAnnouncementAction } as const;

/** Restore one item from the recycle bin, through the action for its kind. */
export function BinRestoreButton({ kind, id, name }: { kind: keyof typeof RUN; id: string; name: string }) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      size="sm"
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
    </Button>
  );
}
