"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/primitives";
import { withdrawDeadRequest } from "@/lib/actions/lead-dead";

/**
 * TAKE BACK A PENDING DEAD REQUEST. Drawn only for the person who asked; the
 * server checks that again under the request's row lock, so this is a
 * convenience and never the rule. Two presses — the first only asks — because
 * withdrawing tells the manager there is nothing to decide.
 */
export function WithdrawButton({ requestId, size }: { requestId: string; size?: "sm" }) {
  const router = useRouter();
  const toast = useToast();
  const [armed, setArmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function run() {
    setBusy(true);
    try {
      const r = await withdrawDeadRequest({ requestId });
      toast.push(r.ok ? (r.message ?? "Withdrawn.") : r.error);
      router.refresh();
    } catch {
      toast.push("The request did not reach MahekOne. Check the connection and try again.");
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  return armed ? (
    <span className="inline-flex items-center gap-2">
      <Button size={size} disabled={busy} onClick={() => void run()}>
        {busy ? "Withdrawing…" : "Yes, withdraw it"}
      </Button>
      <Button size={size} variant="secondary" disabled={busy} onClick={() => setArmed(false)}>
        Keep it
      </Button>
    </span>
  ) : (
    <Button size={size} variant="secondary" onClick={() => setArmed(true)}>
      Withdraw request
    </Button>
  );
}
