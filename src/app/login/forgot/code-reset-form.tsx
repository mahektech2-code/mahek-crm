"use client";

import * as React from "react";
import { useActionState } from "react";
import Link from "next/link";
import { requestSignInCode, resetPasswordWithCode } from "@/lib/actions/auth";
import { cx } from "@/components/ui/primitives";

const FIELD =
  "h-10 w-full rounded-[6px] border bg-surface px-3 text-[15px] text-ink outline-none focus:border-brand";

/**
 * A forgotten password, reset from the phone in the person's pocket: a code
 * to the work number on the account, then the new password. For the people
 * who know their number and not their office email — most of the field team.
 */
export function CodeResetForm() {
  const [state, formAction, pending] = useActionState(resetPasswordWithCode, null);
  const [identifier, setIdentifier] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);

  if (state && state.ok) {
    return (
      <div className="rounded-[6px] border border-line bg-surface p-6">
        <p className="text-sm text-ink">{state.message}</p>
        <Link href="/login" className="mt-3 inline-block text-sm font-medium text-brand">
          Go to sign in
        </Link>
      </div>
    );
  }

  const error = state && !state.ok ? state.error : sendError;

  async function send() {
    setSending(true);
    setSendError(null);
    try {
      const r = await requestSignInCode(identifier, "password_reset");
      if (r.ok) setSent(r.data.sentTo);
      else setSendError(r.error);
    } finally {
      setSending(false);
    }
  }

  return (
    <form action={formAction} className="rounded-[6px] border border-line bg-surface p-6">
      <div className="text-sm font-semibold text-ink">Reset with a WhatsApp code</div>
      <p className="mt-1 text-[13px] text-muted">We send a code to the work number on your account.</p>
      {error ? (
        <div role="alert" className="mt-3 rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-sm text-ink">
          {error}
        </div>
      ) : null}
      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Work number or email</span>
        <input
          name="identifier"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          placeholder="9820011001"
          className={cx(FIELD, "border-line")}
        />
      </label>
      {sent ? (
        <>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Code from WhatsApp</span>
            <input name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="6-digit code" className={cx(FIELD, "border-line tracking-[0.2em]")} />
            <span className="mt-1 flex justify-between text-[12px] text-muted">
              <span>Sent to {sent}.</span>
              <button type="button" onClick={send} disabled={sending} className="cursor-pointer font-medium text-brand">
                Send again
              </button>
            </span>
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">New password</span>
            <input name="password" type="password" autoComplete="new-password" className={cx(FIELD, "border-line")} />
            <span className="mt-1 block text-[12px] text-muted">At least 8 characters.</span>
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">Confirm new password</span>
            <input name="confirm" type="password" autoComplete="new-password" className={cx(FIELD, "border-line")} />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="mt-4 h-10 w-full cursor-pointer rounded-[6px] border border-brand bg-brand text-sm font-medium text-white disabled:cursor-progress disabled:opacity-70"
          >
            {pending ? "Saving…" : "Set new password"}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={sending || !identifier.trim()}
          className="mt-4 h-10 w-full cursor-pointer rounded-[6px] border border-brand bg-brand text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-70"
        >
          {sending ? "Sending…" : "Send me a code"}
        </button>
      )}
    </form>
  );
}
