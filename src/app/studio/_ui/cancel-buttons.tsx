"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { cancelBatch } from "@/lib/actions/studio";
import { cancelForward } from "@/lib/actions/studio-forward";

/* ---------------------------------------------------------------------------
 * CANCELLING IN THE STUDIO NEVER UNSENDS. MahekOne sent none of it — a poster
 * leaves by a download or a chat somebody opened — so each dialog says plainly
 * what stops and that what already went stays gone.
 * ------------------------------------------------------------------------- */

export function CancelBatchButton({ id, unshared, shared }: { id: string; unshared: number; shared: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Cancel run
      </Button>
      <ConfirmDialog
        open={open}
        title="Cancel this bulk run?"
        body={
          <>
            <p className="m-0">
              {unshared === 1 ? "The 1 poster" : `The ${unshared} posters`} nobody has downloaded or sent yet leave My posters and the ZIP.
            </p>
            <p className="mt-2 mb-0">
              {shared
                ? `${shared === 1 ? "1 poster was" : `${shared} posters were`} already shared — what was sent stays sent, and ${shared === 1 ? "it stays" : "they stay"} on your list.`
                : "None of them has been shared yet."}
            </p>
          </>
        }
        confirmLabel="Cancel run"
        cancelLabel="Keep it"
        destructive
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          const r = await cancelBatch(id);
          toast.push(r.ok ? (r.message ?? "Cancelled.") : r.error, r.ok ? undefined : "error");
          if (r.ok) router.refresh();
        }}
      />
    </>
  );
}

export function CancelForwardButton({ id, started, notDone, sent }: { id: string; started: boolean; notDone: number; sent: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Cancel forward
      </Button>
      <ConfirmDialog
        open={open}
        title="Cancel this forward?"
        body={
          started ? (
            <>
              <p className="m-0">
                {notDone ? `${notDone} ${notDone === 1 ? "person" : "people"} not done yet will not be offered a chat.` : "Everybody on the list has been dealt with."}
              </p>
              <p className="mt-2 mb-0">
                {sent ? `${sent} marked sent — what was sent stays sent; MahekOne cannot take a WhatsApp message back.` : "Nobody has been marked sent."} Each person keeps the status you gave them.
              </p>
            </>
          ) : (
            <p className="m-0">It has not been started, so nobody has been sent anything. It stays in your list, marked cancelled.</p>
          )
        }
        confirmLabel="Cancel forward"
        cancelLabel="Keep it"
        destructive
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          const r = await cancelForward(id);
          toast.push(r.ok ? (r.message ?? "Cancelled.") : r.error, r.ok ? undefined : "error");
          if (r.ok) router.refresh();
        }}
      />
    </>
  );
}
