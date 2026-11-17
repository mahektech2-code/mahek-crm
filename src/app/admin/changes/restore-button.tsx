"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { updateConfigSetting } from "@/lib/actions/crm";
import { btnClass } from "../_shell/kit";

/** Puts a setting's earlier value back, through the one settings writer. */
export function RestoreButton({
  settingKey,
  value,
  label,
}: {
  settingKey: string;
  value: unknown;
  label: string;
}) {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className={btnClass("plain", "sm")}
      disabled={busy}
      title={`Set it back to ${label}`}
      onClick={async () => {
        if (!window.confirm(`Set this setting back to ${label}?`)) return;
        setBusy(true);
        const r = await updateConfigSetting(settingKey, value);
        setBusy(false);
        notify(
          r.ok ? `Restored to ${label}.` : r.error,
          r.ok ? "info" : "error",
        );
        if (r.ok) router.refresh();
      }}
    >
      Restore
    </button>
  );
}
