"use client";

import * as React from "react";
import { useActionState } from "react";
import { signIn } from "@/lib/actions/auth";
import { Button, cx } from "@/components/ui/primitives";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, null);
  const [showPass, setShowPass] = React.useState(false);
  const failed = Boolean(state && !state.ok);

  return (
    <form action={formAction} className="mt-6 max-w-[380px]">
      {failed ? (
        <div
          role="alert"
          className="mb-5 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3 py-2.5 text-sm text-ink"
        >
          {state && !state.ok ? state.error : null}
        </div>
      ) : null}

      <label className="block">
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Work number or email
        </span>
        <input
          name="identifier"
          autoComplete="username"
          autoFocus
          placeholder="priya@mahek.in"
          className={cx(
            "h-9 w-full rounded-[4px] border bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand",
            failed ? "border-danger" : "border-line",
          )}
        />
      </label>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Password
        </span>
        <span className="relative block">
          <input
            name="password"
            type={showPass ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            className={cx(
              "h-9 w-full rounded-[4px] border bg-surface pr-14 pl-2.5 text-sm text-ink outline-none focus:border-brand",
              failed ? "border-danger" : "border-line",
            )}
          />
          <button
            type="button"
            onClick={() => setShowPass((s) => !s)}
            className="absolute top-1.5 right-2 h-6 cursor-pointer px-1.5 text-[13px] text-muted hover:text-body"
          >
            {showPass ? "Hide" : "Show"}
          </button>
        </span>
      </label>

      <label className="mt-3.5 flex cursor-pointer items-center gap-2 text-sm text-body">
        <input
          type="checkbox"
          name="remember"
          defaultChecked
          className="h-[15px] w-[15px] accent-[#6835FB]"
        />
        Keep me signed in on this computer
      </label>

      <Button
        type="submit"
        variant="primary"
        disabled={pending}
        className="mt-5 h-10 w-full text-[15px]"
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>

      <p className="mt-3.5 text-[13px] leading-[19px] text-muted">
        Accounts are created by your manager — there is no sign-up. Forgotten
        your password? Ask your manager to reset it, or{" "}
        <a
          href="https://wa.me/919822014567"
          target="_blank"
          rel="noopener noreferrer"
        >
          message support on WhatsApp
        </a>
        .
      </p>
    </form>
  );
}
