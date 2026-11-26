"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";

/* Small pieces every Train screen shares: the input look, a switch, and running an action. */

export const inputCls = "h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand disabled:bg-canvas disabled:text-muted";
export const areaCls = "w-full rounded-[4px] border border-line-strong bg-surface px-2.5 py-2 text-sm leading-5 text-heading outline-none focus:border-brand disabled:bg-canvas";

type R = { ok: boolean; message?: string; error?: string; detail?: unknown };

/** Run a server action: toast its answer, refresh on success. Problems in `detail` are shown too. */
export function useRun() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const run = <T extends R>(p: () => Promise<T>, after?: (r: T) => void) =>
    start(async () => {
      const r = await p();
      if (r.ok) {
        if (r.message) toast.push(r.message);
        after?.(r);
        router.refresh();
      } else {
        const more = Array.isArray(r.detail) && r.detail.length > 1 ? ` (+${r.detail.length - 1} more)` : "";
        toast.push((r.error ?? "That did not save.") + more, "error");
      }
    });
  return { pending, run };
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      title={disabled ? "Read-only here" : undefined}
      onClick={() => onChange(!on)}
      className={cx("relative h-5 w-[34px] flex-none cursor-pointer rounded-[10px] border-0 transition-colors disabled:cursor-not-allowed disabled:opacity-60", on ? "bg-brand" : "bg-line-strong")}
    >
      <span className={cx("absolute top-[2px] h-4 w-4 rounded-full bg-white transition-[left]", on ? "left-4" : "left-[2px]")} />
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <span role="group" aria-label={label} className="inline-flex gap-0.5 rounded-[6px] border border-line bg-surface p-[3px]">
      {options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          disabled={disabled}
          title={disabled ? "Read-only here" : undefined}
          onClick={() => onChange(k)}
          className={cx("h-7 cursor-pointer rounded-[4px] border-0 px-2.5 text-xs font-medium disabled:cursor-not-allowed", value === k ? "bg-heading text-white" : "bg-transparent text-body")}
        >
          {l}
        </button>
      ))}
    </span>
  );
}

/** The problems a publish would refuse on, said before anybody presses Publish. */
export function Problems({ items }: { items: string[] }) {
  if (!items.length) return <div className="rounded-[4px] bg-success-soft px-3 py-2.5 text-[13px] text-success">Ready to publish.</div>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 rounded-[4px] bg-warn-soft px-3 py-2.5 text-[13px] leading-[19px] text-warn-ink">
      {items.slice(0, 8).map((p) => (
        <li key={p}>! {p}</li>
      ))}
      {items.length > 8 ? <li>…and {items.length - 8} more</li> : null}
    </ul>
  );
}
