"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { releaseDevice } from "@/lib/actions/sales";
import { Button } from "../parts";

/**
 * The other half of one handset per person.
 *
 * The rule refused a second phone and told the salesman to ask an admin to
 * release the first. This is that admin doing it — and until now the sentence
 * pointed at nothing: no screen released a handset, and the only way through
 * was a DELETE against production.
 *
 * The dialog says what is about to happen in the order it happens, because
 * "release" on its own reads like tidying a list rather than signing somebody
 * out mid-week: the phone stops syncing on its next call, the work already on
 * it is safe, and he can sign in on a new one.
 */
export function ReleaseButton({
  deviceId,
  salesmanName,
  handset,
}: {
  deviceId: string;
  salesmanName: string;
  /** "Xiaomi Redmi Note 12" — what he will recognise as the phone. */
  handset: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await releaseDevice({ deviceId, reason });
    } finally {
      // Cleared whatever happened — an action that throws rather than
      // returning a Result would otherwise leave the button dead.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setReason("");
    toast.push(result.message ?? "Released.");
    router.refresh();
  }

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        Release
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Release this handset" width={520}>
        <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
          <div className="font-medium text-ink">{salesmanName}</div>
          <div className="text-muted">{handset}</div>
        </div>

        <p className="mb-3 text-[13px] leading-5 text-body">
          The phone stops syncing the next time it reaches MahekOne, and{" "}
          {salesmanName.split(" ")[0]} can sign in on a new one. Anything already saved on
          the old handset and not yet sent stays on it — releasing does not delete his
          work, and it does not delete the record of which phone he was on.
        </p>

        <label className="mb-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            Why it is being released
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Phone broken, replaced with a company handset"
            autoFocus
            className="h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand"
          />
          <span className="mt-1 block text-[12px] text-muted">
            Kept on the row and sent to him, so nobody has to guess later why he was
            signed out.
          </span>
        </label>

        {error ? (
          <p className="mb-3 text-[13px] text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button tone="primary" onClick={submit} disabled={busy || reason.trim().length < 3}>
            {busy ? "Releasing…" : "Release the handset"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
