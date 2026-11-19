"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { updateConfigSetting } from "@/lib/actions/crm";
import { btnClass } from "../_shell/kit";

/** Puts a setting's earlier value back, through the one settings writer — after asking. */
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
  const [asking, setAsking] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className={btnClass("plain", "sm")}
        title={`Set it back to ${label}`}
        onClick={() => setAsking(true)}
      >
        Restore
      </button>
      <ConfirmDialog
        open={asking}
        title="Restore this setting?"
        body={`It goes back to ${label}, for everybody, from the next screen they open. The change is recorded here like any other.`}
        confirmLabel="Restore"
        cancelLabel="Leave it"
        onConfirm={async () => {
          const r = await updateConfigSetting(settingKey, value);
          notify(r.ok ? `Restored to ${label}.` : r.error, r.ok ? "info" : "error");
          if (r.ok) router.refresh();
        }}
        onClose={() => setAsking(false)}
      />
    </>
  );
}
