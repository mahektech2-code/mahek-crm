"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { signIn } from "@/lib/actions/auth";
import { Icon } from "@/components/shell/icons";
import { cx } from "@/components/ui/primitives";

const FIELD =
  "h-10 w-full rounded-[6px] border bg-surface pl-9 text-[15px] text-ink outline-none " +
  "focus:border-brand focus:shadow-[0_0_0_3px_var(--color-brand-soft)]";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, null);
  const [showPass, setShowPass] = React.useState(false);
  const failed = Boolean(state && !state.ok);

  return (
    <>
      {failed ? (
        <div
          role="alert"
          className="mt-4 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3 py-2.5 text-sm text-ink"
        >
          {state && !state.ok ? state.error : null}
        </div>
      ) : null}

      <form
        action={formAction}
        className="animate-rise mt-5 rounded-[6px] border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(22,22,22,0.06)] [animation-delay:80ms]"
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Work email or number
          </span>
          <span className="relative block">
            <Icon
              name="mail"
              size={16}
              className="pointer-events-none absolute top-3 left-3 text-muted"
            />
            <input
              name="identifier"
              autoComplete="username"
              autoFocus
              placeholder="priya@mahek.in"
              className={cx(FIELD, failed ? "border-danger" : "border-line")}
            />
          </span>
        </label>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Password
          </span>
          <span className="relative block">
            <Icon
              name="lock"
              size={16}
              className="pointer-events-none absolute top-3 left-3 text-muted"
            />
            <input
              name="password"
              type={showPass ? "text" : "password"}
              autoComplete="current-password"
              placeholder="••••••••"
              className={cx(
                FIELD,
                "pr-16",
                failed ? "border-danger" : "border-line",
              )}
            />
            <button
              type="button"
              onClick={() => setShowPass((s) => !s)}
              className="absolute top-2 right-1.5 h-6 cursor-pointer rounded-[4px] px-2 text-[13px] font-medium text-muted hover:bg-canvas hover:text-body"
            >
              {showPass ? "Hide" : "Show"}
            </button>
          </span>
        </label>

        <div className="mt-4 flex items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-body">
            <input
              type="checkbox"
              name="remember"
              defaultChecked
              className="h-[15px] w-[15px] accent-[#6835FB]"
            />
            Keep me signed in
          </label>
          <Link
            href="/login/forgot"
            className="text-sm font-medium text-brand no-underline hover:underline"
          >
            Forgot password?
          </Link>
        </div>

        <button
          type="submit"
          disabled={pending}
          className={cx(
            "mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-[6px] border border-brand bg-brand",
            "text-[15px] font-medium text-white shadow-[0_1px_2px_rgba(22,22,22,0.06)] transition-colors duration-100",
            pending
              ? "cursor-progress opacity-70"
              : "cursor-pointer hover:border-brand-hover hover:bg-brand-hover",
          )}
        >
          {pending ? "Signing in" : "Sign in"}
          {pending ? (
            <span className="animate-spin-swift block h-[15px] w-[15px] flex-none rounded-full border-2 border-white/35 border-t-white" />
          ) : (
            <Icon name="arrowRight" size={16} strokeWidth={1.8} />
          )}
        </button>
      </form>
    </>
  );
}
