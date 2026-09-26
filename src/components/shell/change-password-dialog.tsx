"use client";

import * as React from "react";
import { useActionState } from "react";
import {
  changePassword,
  passwordChangeUsesCode,
  sendPasswordChangeCode,
} from "@/lib/actions/account";
import { Modal } from "@/components/ui/modal";
import { cx } from "@/components/ui/primitives";

const FIELD =
  "h-10 w-full rounded-[6px] border bg-surface px-3 text-[15px] text-ink outline-none focus:border-brand";

/**
 * Changing your own password, without leaving the screen you are on.
 *
 * A DIALOG RATHER THAN A PAGE, because the two people this is for are in the
 * middle of something: a telecaller with a customer on the line and a manager
 * three filters deep into a list. A route would throw both of those away to
 * ask for three fields, and the way back is a browser button nobody trusts
 * mid-call.
 *
 * `/login/reset` stays the page it is — somebody spending a link has no screen
 * to be taken away from, and no session either.
 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(changePassword, null);
  // Whether this deployment proves it is you with a WhatsApp code (Mahek's
  // rule) or, until codes are set up, with the current password. Null while
  // asking, so neither field flashes up and is swapped out.
  const [usesCode, setUsesCode] = React.useState<boolean | null>(null);
  const [codeSent, setCodeSent] = React.useState<string | null>(null);
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    passwordChangeUsesCode()
      .then((v) => live && setUsesCode(v))
      .catch(() => live && setUsesCode(false));
    return () => {
      live = false;
    };
  }, []);
  const saved = state && state.ok ? state : null;

  /** A message under the field it names, never under whichever came first. */
  const fieldError = (field: string) =>
    state && !state.ok
      ? (state.fieldErrors?.find((e) => e.field === field)?.message ?? null)
      : null;
  /*
   * The banner carries what no field can: a wrong current password names its
   * own box, and "that account no longer exists" names none of them.
   */
  const banner =
    state && !state.ok && !state.fieldErrors?.length ? state.error : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={saved ? "Password changed" : "Change your password"}
      width={440}
    >
      {saved ? (
        <>
          <p className="text-sm leading-6 text-body">{saved.message}</p>
          <p className="mt-2.5 text-[13px] leading-5 text-muted">
            You are still signed in here. Anywhere else - a phone, a machine at
            home - will ask for the new password.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-5 flex h-9 cursor-pointer items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body hover:bg-canvas"
          >
            Done
          </button>
        </>
      ) : (
        <form action={formAction}>
          {banner ? (
            <div
              role="alert"
              className="mb-4 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3 py-2.5 text-sm text-ink"
            >
              {banner}
            </div>
          ) : null}

          {usesCode === null ? (
            <p className="text-[13px] text-muted">One moment…</p>
          ) : usesCode ? (
            <div>
              <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
                Code from WhatsApp
              </span>
              <div className="flex gap-2">
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  className={cx(FIELD, fieldError("code") ? "border-danger" : "border-line")}
                />
                <button
                  type="button"
                  disabled={sending}
                  onClick={async () => {
                    setSending(true);
                    setCodeError(null);
                    try {
                      const r = await sendPasswordChangeCode();
                      if (r.ok) setCodeSent(r.data.sentTo);
                      else setCodeError(r.error);
                    } finally {
                      setSending(false);
                    }
                  }}
                  className="h-10 flex-none cursor-pointer rounded-[6px] border border-line-strong bg-surface px-3 text-sm font-medium whitespace-nowrap text-body hover:bg-canvas disabled:cursor-progress disabled:opacity-70"
                >
                  {sending ? "Sending…" : codeSent ? "Send again" : "Send code"}
                </button>
              </div>
              {fieldError("code") || codeError ? (
                <span className="mt-1.5 block text-[13px] text-danger">{fieldError("code") ?? codeError}</span>
              ) : (
                <span className="mt-1.5 block text-[13px] text-muted">
                  {codeSent
                    ? `Sent to ${codeSent} on WhatsApp.`
                    : "We send a code to the work number on your account."}
                </span>
              )}
            </div>
          ) : (
            <Field
              name="current"
              label="Current password"
              autoComplete="current-password"
              autoFocus
              error={fieldError("current")}
            />
          )}
          <Field
            name="password"
            label="New password"
            autoComplete="new-password"
            hint="At least 8 characters."
            error={fieldError("password")}
          />
          <Field
            name="confirm"
            label="Confirm new password"
            autoComplete="new-password"
            error={fieldError("confirm")}
          />

          <p className="mt-4 text-[13px] leading-5 text-muted">
            Saving signs out every other device on this account. This one stays
            signed in.
          </p>

          <div className="mt-4 flex justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 cursor-pointer items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body hover:bg-canvas"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className={cx(
                "flex h-9 items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white",
                pending
                  ? "cursor-progress opacity-70"
                  : "cursor-pointer hover:border-brand-hover hover:bg-brand-hover",
              )}
            >
              {pending ? "Saving…" : "Change password"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Field({
  name,
  label,
  autoComplete,
  autoFocus,
  hint,
  error,
}: {
  name: string;
  label: string;
  autoComplete: string;
  autoFocus?: boolean;
  hint?: string;
  error: string | null;
}) {
  return (
    <label className="mt-3.5 block first:mt-0">
      <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <input
        name={name}
        type="password"
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className={cx(FIELD, error ? "border-danger" : "border-line")}
      />
      {error ? (
        <span className="mt-1.5 block text-[13px] text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[13px] text-muted">{hint}</span>
      ) : null}
    </label>
  );
}
