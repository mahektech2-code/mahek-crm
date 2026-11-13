"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { reviseDesign } from "@/lib/actions/studio";

/* Starts a new version of a published design — a private draft with its own copy
   of the artwork and the placement as it stands — and opens it. The version it
   replaces is kept for every poster already made from it. */
export function ReviseButton({ designId }: { designId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      disabled={busy}
      data-testid="revise"
      onClick={async () => {
        setBusy(true);
        const r = await toast.run(reviseDesign(designId));
        setBusy(false);
        if (r.ok) router.push(`/studio/designs/${r.data.id}`);
      }}
    >
      {busy ? "Preparing…" : "Create a new version"}
    </Button>
  );
}
