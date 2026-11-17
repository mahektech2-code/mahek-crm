"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { updateConfigSettings } from "@/lib/actions/crm";
import { btnClass, Pill } from "../_shell/kit";
import { sweepStorageNow } from "./actions";

/** "Sweep now", in the title row: says how many files it took. */
export function SweepButton() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [said, setSaid] = React.useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2.5">
      {said ? <span className="text-xs text-muted">{said}</span> : null}
      <button
        type="button"
        disabled={busy}
        className={btnClass("plain")}
        onClick={async () => {
          setBusy(true);
          const r = await sweepStorageNow();
          setBusy(false);
          setSaid(r.ok ? (r.data.swept ? `${r.data.swept} file${r.data.swept === 1 ? "" : "s"} swept` : "Nothing was due") : r.error);
          if (r.ok) router.refresh();
        }}
      >
        {busy ? "Sweeping…" : "Sweep now"}
      </button>
    </span>
  );
}

export type KeepRow = { key: string; label: string; value: number; unit: string; schedule: string; isNew?: boolean };

/** "Kept for": each window edited in place, saved together through the audited settings write. */
export function KeptFor({ rows, largest }: { rows: KeepRow[]; largest: { size: string; name: string } | null }) {
  const router = useRouter();
  const [vals, setVals] = React.useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.key, String(r.value)])));
  const [state, setState] = React.useState<{ busy: boolean; said: string | null; bad: boolean }>({ busy: false, said: null, bad: false });
  const changed = rows.filter((r) => vals[r.key] !== String(r.value));
  return (
    <>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_120px_110px] items-center gap-3 border-b border-divider px-[18px] py-3.5">
          <b className="font-semibold text-ink">{r.label}</b>
          <div className="flex h-9 items-center overflow-hidden rounded-control border border-line-strong focus-within:border-brand">
            <input
              aria-label={r.label}
              inputMode="numeric"
              value={vals[r.key]}
              onChange={(e) => {
                setVals({ ...vals, [r.key]: e.target.value.replace(/[^0-9]/g, "") });
                setState({ busy: false, said: null, bad: false });
              }}
              className="w-full min-w-0 border-0 bg-transparent px-2.5 text-right text-sm font-semibold text-ink outline-none"
            />
            <span className="flex h-full items-center border-l border-divider bg-[#f7f9fc] px-2.5 text-[13px] text-muted">{r.unit}</span>
          </div>
          <span>
            <Pill tone={r.isNew ? "brand" : "ok"}>{r.schedule}</Pill>
          </span>
        </div>
      ))}
      {largest ? (
        <div className="grid grid-cols-[minmax(0,1fr)_120px_110px] items-center gap-3 border-b border-divider px-[18px] py-3.5">
          <b className="font-semibold text-ink">Largest file</b>
          <span className="font-mono text-[13px]">{largest.size}</span>
          <span className="truncate text-muted" title={largest.name}>
            {largest.name}
          </span>
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-3 px-[18px] py-3.5">
        {state.said ? <span className={state.bad ? "text-xs text-danger" : "text-xs text-success"}>{state.said}</span> : null}
        <button
          type="button"
          disabled={state.busy || changed.length === 0}
          className={btnClass("primary")}
          onClick={async () => {
            if (changed.some((r) => vals[r.key] === "")) {
              setState({ busy: false, said: "Every window needs a number.", bad: true });
              return;
            }
            setState({ busy: true, said: null, bad: false });
            const res = await updateConfigSettings(changed.map((r) => ({ key: r.key, value: Number(vals[r.key]) })));
            setState({ busy: false, said: res.ok ? "Saved" : res.error, bad: !res.ok });
            if (res.ok) router.refresh();
          }}
        >
          {state.busy ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}
