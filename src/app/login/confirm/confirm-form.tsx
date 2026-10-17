"use client";

import { useActionState } from "react";
import { confirmConsolePassword } from "@/lib/actions/console-confirm";
import { cx } from "@/components/ui/primitives";

const FIELD =
  "h-10 w-full rounded-[6px] border bg-surface px-3 text-[15px] text-ink outline-none focus:border-brand";

export function ConsoleConfirmForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(confirmConsolePassword, null);
  const failed = Boolean(state && !state.ok);

  return (
    <form
      action={formAction}
      className="mt-5 rounded-[6px] border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(22,22,22,0.06)]"
    >
      <input type="hidden" name="next" value={next} />

      {failed ? (
        <div
          role="alert"
          className="mb-4 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3 py-2.5 text-sm text-ink"
        >
          {state && !state.ok ? state.error : null}
        </div>
      ) : null}

      <label className="block">
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Password
        </span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          className={cx(FIELD, failed ? "border-danger" : "border-line")}
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className={cx(
          "mt-5 h-11 w-full rounded-[6px] border border-brand bg-brand text-[15px] font-medium text-white",
          "shadow-[0_1px_2px_rgba(22,22,22,0.06)] transition-colors duration-100",
          pending
            ? "cursor-progress opacity-70"
            : "cursor-pointer hover:border-brand-hover hover:bg-brand-hover",
        )}
      >
        {pending ? "Checking…" : "Open the Admin Console"}
      </button>
    </form>
  );
}
