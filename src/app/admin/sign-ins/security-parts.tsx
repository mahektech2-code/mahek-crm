"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { updateConfigSettings } from "@/lib/actions/crm";
import { btnClass, Card, Pill } from "../_shell/kit";
import { endEverySession } from "./actions";

/** Signs everybody else out, after the word END is typed back. */
export function EndEverySessionButton() {
  const router = useRouter();
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className={btnClass()}
      disabled={busy}
      onClick={async () => {
        const typed = window.prompt(
          "This signs every account out of MahekOne except you. Type END to go ahead.",
        );
        if (typed == null) return;
        setBusy(true);
        const r = await endEverySession(typed);
        setBusy(false);
        notify(
          r.ok ? (r.message ?? "Done.") : r.error,
          r.ok ? "info" : "error",
        );
        if (r.ok) router.refresh();
      }}
    >
      End every session
    </button>
  );
}

export type PolicyField = {
  key: string | null;
  label: string;
  unit: string;
  value: number;
  min?: number;
  max?: number;
  title?: string;
};

/** The sign-in policy, each figure a box, saved through the one settings writer. */
export function PolicyPanel({
  fields,
  template,
  canWrite,
}: {
  fields: PolicyField[];
  template: { ok: boolean; why: string };
  canWrite: boolean;
}) {
  const router = useRouter();
  const notify = useToast().push;
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.filter((f) => f.key).map((f) => [f.key!, String(f.value)]),
    ),
  );
  const [busy, setBusy] = React.useState(false);
  const changed = fields.filter(
    (f) => f.key && values[f.key] !== String(f.value),
  );

  return (
    <Card>
      <div className="flex items-center gap-2.5 border-b border-divider px-[18px] py-4">
        <h2 className="m-0 flex-1 text-[15px] font-bold text-ink">
          Sign-in policy
        </h2>
      </div>
      {fields.map((f) => (
        <div
          key={f.label}
          className="flex items-center gap-3 border-b border-divider px-[18px] py-3.5"
          title={f.title}
        >
          <span className="flex-1 text-[14px] text-ink">{f.label}</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label={f.label}
            disabled={!f.key || !canWrite}
            min={f.min}
            max={f.max}
            value={f.key ? (values[f.key] ?? "") : String(f.value)}
            onChange={(e) =>
              f.key &&
              setValues((v) => ({
                ...v,
                [f.key!]: e.target.value.replace(/[^\d]/g, ""),
              }))
            }
            className="h-[38px] w-[94px] rounded-control border border-line-strong bg-surface px-3 text-right text-[15px] font-semibold text-ink tabular-nums disabled:bg-page disabled:text-muted"
          />
          <span className="w-9 text-muted">{f.unit}</span>
        </div>
      ))}
      <div className="flex items-center gap-3 border-b border-divider px-[18px] py-3.5">
        <span className="flex-1 text-[14px] text-ink">Code template</span>
        <Pill tone={template.ok ? "ok" : "warn"} title={template.why}>
          {template.ok ? "Approved" : "Not set"}
        </Pill>
        <span
          title={template.why}
          className="inline-flex h-5 w-5 flex-none cursor-help items-center justify-center rounded-full border border-line-strong bg-surface text-[11px] font-semibold text-muted"
        >
          i
        </span>
      </div>
      <div className="flex justify-end px-[18px] py-3.5">
        <button
          type="button"
          className={btnClass("primary")}
          disabled={!canWrite || busy || changed.length === 0}
          onClick={async () => {
            setBusy(true);
            const r = await updateConfigSettings(
              changed.map((f) => ({
                key: f.key!,
                value: Number(values[f.key!]),
              })),
            );
            setBusy(false);
            notify(r.ok ? "Policy saved." : r.error, r.ok ? "info" : "error");
            if (r.ok) router.refresh();
          }}
        >
          Save policy
        </button>
      </div>
    </Card>
  );
}
