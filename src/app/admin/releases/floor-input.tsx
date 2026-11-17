"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { updateConfigSetting } from "@/lib/actions/crm";

/**
 * "Ask to update below", edited where it is read. Saved on Enter or on leaving
 * the box, through the same audited write the Settings screen uses; blank asks
 * nobody.
 */
export function FloorInput({ id, settingKey, value }: { id: string; settingKey: string; value: string }) {
  const router = useRouter();
  const [v, setV] = React.useState(value);
  const [state, setState] = React.useState<"idle" | "saving" | "saved" | string>("idle");
  const save = async () => {
    if (v.trim() === value) return;
    setState("saving");
    const r = await updateConfigSetting(settingKey, v.trim());
    if (r.ok) {
      setState("saved");
      router.refresh();
    } else setState(r.error);
  };
  return (
    <div className="flex items-center gap-2">
      {state !== "idle" && state !== "saving" ? (
        <span className={state === "saved" ? "text-xs text-success" : "max-w-[220px] truncate text-xs text-danger"} title={state === "saved" ? undefined : state}>
          {state === "saved" ? "Saved" : state}
        </span>
      ) : null}
      <input
        id={id}
        value={v}
        placeholder="—"
        disabled={state === "saving"}
        onChange={(e) => {
          setV(e.target.value);
          setState("idle");
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        className="h-9 w-[100px] rounded-control border border-line-strong bg-surface px-2.5 font-mono text-sm font-semibold text-ink focus:border-brand focus:outline-none"
      />
    </div>
  );
}
