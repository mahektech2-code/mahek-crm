"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { requestSignInCode, signIn, signInWithCode } from "@/lib/actions/auth";
import { Icon } from "@/components/shell/icons";
import { cx } from "@/components/ui/primitives";

const FIELD =
  "h-10 w-full rounded-[6px] border bg-surface pl-9 text-[15px] text-ink outline-none " +
  "focus:border-brand focus:shadow-[0_0_0_3px_var(--color-brand-soft)]";

/**
 * Two ways in, one screen: the password, or — where WhatsApp codes are set up
 * — a code sent to the work number on the account. The choice is offered only
 * when codes can actually be sent; otherwise this is the password form alone,
 * exactly as it always was.
 */
export function LoginForm({ codesOffered = false }: { codesOffered?: boolean }) {
  const [mode, setMode] = React.useState<"password" | "code">("password");
  return (
    <>
      {codesOffered ? (
        <div className="animate-rise mt-5 grid grid-cols-2 rounded-[6px] border border-line bg-surface p-1 [animation-delay:60ms]">
          {(["password", "code"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cx(
                "h-9 cursor-pointer rounded-[4px] text-sm font-medium",
                mode === m ? "bg-brand-soft text-ink" : "text-muted hover:text-body",
              )}
            >
              {m === "password" ? "Password" : "WhatsApp code"}
            </button>
          ))}
        </div>
      ) : null}
      {mode === "password" ? <PasswordForm /> : <CodeForm />}
    </>
  );
}

function PasswordForm() {
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
              name="person"
              size={16}
              className="pointer-events-none absolute top-3 left-3 text-muted"
            />
            <input
              name="identifier"
              autoComplete="username"
              autoFocus
              /* BOTH, and the placeholder has to show both. This field has
                 always taken either — `signIn` matches the last ten digits
                 against `users.phone` as well as the whole string against the
                 email — but it advertised one, so the telecallers and field
                 staff who know their work number and not their office email
                 had no way to find that out from the screen. */
              placeholder="9820011001 or priya@mahek.in"
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
            className="text-sm font-medium text-brand no-underline"
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

/** Sign in with a one-time code on WhatsApp: ask for it, then type it. */
function CodeForm() {
  const [state, formAction, pending] = useActionState(signInWithCode, null);
  const [identifier, setIdentifier] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const failed = Boolean(state && !state.ok);
  const error = failed && state && !state.ok ? state.error : sendError;

  async function send() {
    setSending(true);
    setSendError(null);
    try {
      const r = await requestSignInCode(identifier);
      if (r.ok) setSent(r.data.sentTo);
      else setSendError(r.error);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3 py-2.5 text-sm text-ink"
        >
          {error}
        </div>
      ) : null}
      <form
        action={formAction}
        className="animate-rise mt-5 rounded-[6px] border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(22,22,22,0.06)]"
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Work email or number
          </span>
          <span className="relative block">
            <Icon name="person" size={16} className="pointer-events-none absolute top-3 left-3 text-muted" />
            <input
              name="identifier"
              autoComplete="username"
              autoFocus
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="9820011001 or priya@mahek.in"
              className={cx(FIELD, error ? "border-danger" : "border-line")}
            />
          </span>
        </label>

        {sent ? (
          <label className="mt-4 block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Code from WhatsApp
            </span>
            <span className="relative block">
              <Icon name="lock" size={16} className="pointer-events-none absolute top-3 left-3 text-muted" />
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder="6-digit code"
                className={cx(FIELD, "tracking-[0.2em]", failed ? "border-danger" : "border-line")}
              />
            </span>
            <span className="mt-1.5 flex items-center justify-between text-[13px] text-muted">
              <span>Sent to {sent} on WhatsApp.</span>
              <button type="button" disabled={sending} onClick={send} className="cursor-pointer font-medium text-brand disabled:opacity-60">
                {sending ? "Sending…" : "Send again"}
              </button>
            </span>
          </label>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-body">
            <input type="checkbox" name="remember" defaultChecked className="h-[15px] w-[15px] accent-[#6835FB]" />
            Keep me signed in
          </label>
        </div>

        {sent ? (
          <button
            type="submit"
            disabled={pending}
            className={cx(
              "mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-[6px] border border-brand bg-brand",
              "text-[15px] font-medium text-white shadow-[0_1px_2px_rgba(22,22,22,0.06)]",
              pending ? "cursor-progress opacity-70" : "cursor-pointer hover:border-brand-hover hover:bg-brand-hover",
            )}
          >
            {pending ? "Signing in" : "Sign in"}
          </button>
        ) : (
          <button
            type="button"
            disabled={sending || !identifier.trim()}
            onClick={send}
            className={cx(
              "mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-[6px] border border-brand bg-brand",
              "text-[15px] font-medium text-white shadow-[0_1px_2px_rgba(22,22,22,0.06)]",
              sending || !identifier.trim() ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:border-brand-hover hover:bg-brand-hover",
            )}
          >
            {sending ? "Sending code" : "Send me a code on WhatsApp"}
          </button>
        )}
      </form>
    </>
  );
}
