"use client";

import { useActionState } from "react";
import { resetPassword } from "@/lib/actions/auth";
import { cx } from "@/components/ui/primitives";

const FIELD =
  "h-10 w-full rounded-[6px] border bg-surface px-3 text-[15px] text-ink outline-none focus:border-brand";

export function ResetForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPassword, null);
  const failed = Boolean(state && !state.ok);

  return (
    <form
      action={formAction}
      className="mt-5 rounded-[6px] border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(22,22,22,0.06)]"
    >
      <input type="hidden" name="token" value={token} />

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
          New password
        </span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          minLength={8}
          className={cx(FIELD, failed ? "border-danger" : "border-line")}
        />
        <span className="mt-1.5 block text-[13px] text-muted">
          At least 8 characters.
        </span>
      </label>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Confirm new password
        </span>
        <input
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={8}
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
        {pending ? "Saving…" : "Set new password"}
      </button>

      <p className="mt-3.5 text-[13px] leading-5 text-muted">
        Setting a new password signs the account out everywhere, so anyone still
        holding the old one is locked out.
      </p>
    </form>
  );
}
