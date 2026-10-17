"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/console/parts";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { triggerJob } from "@/lib/actions/crm";

/**
 * Re-read every stored activity date, from the screen that shows them.
 *
 * Drawn for a platform administrator only, and `triggerJob` refuses anybody
 * else on the server — a hidden button is not a permission. It touches no
 * Google sheet: it re-reads the cells already stored, so it is safe to press
 * twice, and the answer is the count of dates it actually moved.
 */
export function ReparseButton() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);

  async function run() {
    const result = await triggerJob("field-activity-reparse");
    if (result.ok) {
      toast.push(result.data?.ran.join(" · ") ?? result.message ?? "Finished");
      router.refresh();
    } else {
      toast.push(result.error);
    }
  }

  return (
    <>
      <Button tone="strong" onClick={() => setOpen(true)}>
        Re-read dates
      </Button>
      <ConfirmDialog
        open={open}
        title="Re-read every activity date?"
        body="Reads each stored row's date again, the way its own sync wrote it, and corrects any that were read the wrong way round. Timeline entries move with them. Nothing is fetched from the sheet."
        confirmLabel="Re-read dates"
        onConfirm={run}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
