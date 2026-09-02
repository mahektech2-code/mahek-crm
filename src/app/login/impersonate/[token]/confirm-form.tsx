"use client";

import { useActionState } from "react";
import { enterImpersonatedSession } from "@/lib/actions/impersonation";
import { cx } from "@/components/ui/primitives";

export function ImpersonateConfirmForm({
  token,
  userName,
}: {
  token: string;
  userName: string;
}) {
  const [state, formAction, pending] = useActionState(enterImpersonatedSession, null);
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

      <button
        type="submit"
        disabled={pending}
        className={cx(
          "h-11 w-full rounded-[6px] border border-brand bg-brand text-[15px] font-medium text-white",
          "shadow-[0_1px_2px_rgba(22,22,22,0.06)] transition-colors duration-100",
          pending
            ? "cursor-progress opacity-70"
            : "cursor-pointer hover:border-brand-hover hover:bg-brand-hover",
        )}
      >
        {pending ? "Signing in…" : `Continue as ${userName}`}
      </button>

      <p className="mt-3.5 text-[13px] leading-5 text-muted">
        This browser signs out of whatever account it currently holds and
        into {userName}&rsquo;s. Other browsers and devices are unaffected.
      </p>
    </form>
  );
}
