"use client";

import * as React from "react";
import { useToast } from "@/components/ui/toast";
import { cx } from "@/components/ui/primitives";
import { startExpenseBillTrial } from "@/lib/actions/admin-console";
import { btnClass } from "../_shell/kit";

/** Starts the bill trial; the reading itself runs on the server after this answers. */
export function ReadBillsButton({ bills, disabledWhy }: { bills: number; disabledWhy: string | null }) {
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className={cx(btnClass("primary", "sm"))}
      disabled={busy || disabledWhy !== null}
      title={disabledWhy ?? `Reads the latest ${bills} expense bill photos not yet in the trial, once with each provider.`}
      onClick={async () => {
        setBusy(true);
        const r = await startExpenseBillTrial();
        setBusy(false);
        notify(r.ok ? (r.message ?? "Started.") : r.error, r.ok ? "info" : "error");
      }}
    >
      {busy ? "Starting…" : "Read bills with both"}
    </button>
  );
}
