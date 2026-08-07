"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordReset } from "@/lib/actions/auth";
import { Icon } from "@/components/shell/icons";
import { cx } from "@/components/ui/primitives";

export function ForgotForm() {
  const [state, formAction, pending] = useActionState(
    requestPasswordReset,
    null,
  );

  // The link was requested — say what happens next rather than clearing the
  // form and leaving the person wondering whether it went.
  if (state?.ok) {
    return (
      <div className="animate-rise">
        <div className="flex h-11 w-11 items-center justify-center rounded-[6px] bg-success-soft text-success">
          <Icon name="mail" size={22} strokeWidth={1.8} />
        </div>
        <h1 className="mt-4 text-[22px] leading-7 font-semibold text-ink">
          Check your email
        </h1>
        <p className="mt-2 text-[15px] leading-6 text-body">
          If <span className="font-medium text-ink">{state.data}</span> has an
          account, a reset link is on its way. It works once and expires in 30
          minutes.
        </p>

        {state.warnings?.length ? (
          <div className="mt-4 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-3 py-2.5 text-[13px] leading-5 text-warn-ink">
            {state.warnings[0]}
          </div>
        ) : null}

        <div className="mt-5 rounded-[6px] border border-line bg-surface p-4 text-sm leading-[21px] text-muted">
          Nothing arrived? Check the spam folder, or send it again - the
          previous link stops working the moment a new one is sent.
        </div>

        <div className="mt-5 flex gap-2.5">
          <Link
            href="/login"
            className="flex h-10 items-center rounded-[6px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:border-brand-hover hover:bg-brand-hover hover:no-underline"
          >
            Back to sign in
          </Link>
          <form action={formAction}>
            <input type="hidden" name="email" value={state.data} />
            <button
              type="submit"
              disabled={pending}
              className="flex h-10 cursor-pointer items-center rounded-[6px] border border-line-strong bg-surface px-4 text-sm font-medium text-body hover:bg-canvas"
            >
              {pending ? "Sending…" : "Send it again"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const failed = Boolean(state && !state.ok);

  return (
    <div>
      <h1 className="text-[22px] leading-7 font-semibold text-ink">
        Forgot your password?
      </h1>
      <p className="mt-1.5 text-sm leading-[21px] text-muted">
        We will email you a link to set a new one.
      </p>

      <form
        action={formAction}
        className="mt-5 rounded-[6px] border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(22,22,22,0.06)]"
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Work email
          </span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="priya@mahek.in"
            className={cx(
              "h-10 w-full rounded-[6px] border bg-surface px-3 text-[15px] text-ink outline-none focus:border-brand",
              failed ? "border-danger" : "border-line",
            )}
          />
          {failed ? (
            <span role="alert" className="mt-1.5 block text-[13px] text-danger">
              {state && !state.ok ? state.error : null}
            </span>
          ) : null}
        </label>

        <button
          type="submit"
          disabled={pending}
          className={cx(
            "mt-4.5 h-11 w-full rounded-[6px] border border-brand bg-brand text-[15px] font-medium text-white",
            "shadow-[0_1px_2px_rgba(22,22,22,0.06)] transition-colors duration-100",
            pending
              ? "cursor-progress opacity-70"
              : "cursor-pointer hover:border-brand-hover hover:bg-brand-hover",
          )}
        >
          {pending ? "Sending…" : "Send reset link"}
        </button>
      </form>

      <p className="mt-4 text-[13px] leading-5 text-muted">
        Accounts are created by your manager, so the link goes to the work email
        on your account. If you are not sure which that is, ask them.
      </p>
    </div>
  );
}
