"use client";

import * as React from "react";
import { useActionState } from "react";
import { requestOtp, verifyOtp, type OtpStep } from "@/lib/actions/auth";
import { Icon } from "@/components/shell/icons";
import { cx } from "@/components/ui/primitives";

const FIELD =
  "h-10 w-full rounded-[6px] border bg-surface pl-9 text-[15px] text-ink outline-none " +
  "focus:border-brand focus:shadow-[0_0_0_3px_var(--color-brand-soft)]";

const BUTTON =
  "flex h-11 w-full items-center justify-center gap-2 rounded-[6px] border border-brand bg-brand " +
  "text-[15px] font-medium text-white shadow-[0_1px_2px_rgba(22,22,22,0.06)] transition-colors duration-100";

/**
 * Two steps, one card: a work number goes out, a code comes back to it. There
 * is no password step any more — see `lib/actions/auth.ts`.
 */
export function LoginForm() {
  const [step, setStep] = React.useState<OtpStep | null>(null);

  return step ? (
    <CodeStep step={step} onChangeNumber={() => setStep(null)} />
  ) : (
    <PhoneStep onSent={setStep} />
  );
}

function PhoneStep({ onSent }: { onSent: (step: OtpStep) => void }) {
  const [state, formAction, pending] = useActionState(requestOtp, null);
  const [channel, setChannel] = React.useState<"sms" | "whatsapp">("sms");
  const failed = Boolean(state && !state.ok);

  React.useEffect(() => {
    if (state?.ok) onSent(state.data);
    // Runs once per fresh submission, not on every render — `state` only
    // changes reference when a new dispatch resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

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
            Work number
          </span>
          <span className="relative block">
            <Icon
              name="phone"
              size={16}
              className="pointer-events-none absolute top-3 left-3 text-muted"
            />
            <input
              name="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              autoFocus
              placeholder="98200 11001"
              className={cx(FIELD, failed ? "border-danger" : "border-line")}
            />
          </span>
        </label>

        <div className="mt-4">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Send the code by
          </span>
          <div className="flex gap-2">
            {(
              [
                { value: "sms", label: "Text message" },
                { value: "whatsapp", label: "WhatsApp" },
              ] as const
            ).map((option) => (
              <label
                key={option.value}
                className={cx(
                  "flex h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] border text-[14px] font-medium transition-colors duration-100",
                  channel === option.value
                    ? "border-brand bg-brand-soft text-brand"
                    : "border-line text-body hover:bg-canvas",
                )}
              >
                <input
                  type="radio"
                  name="channel"
                  value={option.value}
                  checked={channel === option.value}
                  onChange={() => setChannel(option.value)}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>

        <button
          type="submit"
          disabled={pending}
          className={cx(
            "mt-5",
            BUTTON,
            pending
              ? "cursor-progress opacity-70"
              : "cursor-pointer hover:border-brand-hover hover:bg-brand-hover",
          )}
        >
          {pending ? "Sending code" : "Send code"}
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

function CodeStep({
  step,
  onChangeNumber,
}: {
  step: OtpStep;
  onChangeNumber: () => void;
}) {
  const [state, formAction, pending] = useActionState(verifyOtp, null);
  const [resendState, resendAction, resending] = useActionState(requestOtp, null);
  const failed = Boolean(state && !state.ok);
  const channelLabel = step.channel === "whatsapp" ? "WhatsApp" : "a text message";

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
      {resendState?.ok && resendState.warnings?.length ? (
        <div className="mt-4 rounded-[4px] border border-line bg-canvas px-3 py-2.5 text-sm text-muted">
          {resendState.warnings[0]}
        </div>
      ) : null}

      <form
        action={formAction}
        className="animate-rise mt-5 rounded-[6px] border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(22,22,22,0.06)] [animation-delay:80ms]"
      >
        <input type="hidden" name="phone" value={step.phone} />

        <p className="text-[14px] leading-5 text-body">
          A code was sent by {channelLabel} to{" "}
          <span className="font-medium text-ink">{step.masked}</span>.
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Code
          </span>
          <span className="relative block">
            <Icon
              name="lock"
              size={16}
              className="pointer-events-none absolute top-3 left-3 text-muted"
            />
            <input
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
              className={cx(FIELD, failed ? "border-danger" : "border-line")}
            />
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
          <button
            type="button"
            onClick={onChangeNumber}
            className="text-sm font-medium text-brand no-underline hover:underline"
          >
            Use a different number
          </button>
        </div>

        <button
          type="submit"
          disabled={pending}
          className={cx(
            "mt-5",
            BUTTON,
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

      <form action={resendAction} className="mt-3 text-center">
        <input type="hidden" name="phone" value={step.phone} />
        <input type="hidden" name="channel" value={step.channel} />
        <button
          type="submit"
          disabled={resending}
          className="text-[13px] font-medium text-brand no-underline hover:underline disabled:cursor-progress disabled:opacity-70"
        >
          {resending ? "Sending" : "Resend code"}
        </button>
      </form>
    </>
  );
}
