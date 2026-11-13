"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, Callout, Field, Input, Textarea, buttonClass, cx } from "@/components/ui/primitives";
import Link from "next/link";
import { noteCopied, planReveal, requestReveal, revealSecret, withdrawReveal } from "@/lib/actions/locker-vault";
import type { RevealPlan } from "@/lib/locker/vault-core";
import type { Tier } from "@/lib/locker/engine";
import { TierPill } from "./kit";
import { LkIcon } from "./icons";


/* ---------------------------------------------------------------------------
 * THE REVEAL, drawn in the v4 dialog's frame: a dialog that asks for exactly
 * what this login's level needs — nothing, a password and a reason, or a
 * second person's approval — then shows the value for a few seconds with the
 * viewer's name across it, and hides it. Every rule is the SERVER's
 * (vault-core.ts); this only asks and shows. Re-revealing is the whole flow
 * again: nothing here keeps a value once it is hidden.
 * ------------------------------------------------------------------------- */

type Step =
  | { k: "loading" }
  | { k: "plan"; plan: RevealPlan }
  | { k: "stepfail" }
  | { k: "revealed"; value: string; until: number; total: number; clip: number; watermark: string | null; field: string; previous: boolean }
  | { k: "hidden"; seconds: number }
  | { k: "error"; msg: string };

const RING = 94.25;

export function RevealButton({
  credentialId,
  title,
  tier,
  field,
  previousSecretId,
  label = "Reveal",
  variant = "primary",
  style,
}: {
  credentialId: string;
  title: string;
  tier: Tier;
  field: string;
  previousSecretId?: string | null;
  label?: string;
  variant?: "primary" | "secondary";
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(0);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(Date.now())} style={style}>
        {label}
      </Button>
      {open ? <RevealDialog key={open} credentialId={credentialId} title={title} tier={tier} field={field} previousSecretId={previousSecretId ?? null} onClose={() => setOpen(0)} /> : null}
    </>
  );
}

const MSG_TONE = { red: "danger", amber: "warn", green: "success", violet: "neutral" } as const;
function Msg({ t, m, tone }: { t: string; m: React.ReactNode; tone: "red" | "amber" | "green" | "violet" }) {
  return (
    <Callout tone={MSG_TONE[tone]} className="mb-0 block">
      <div className="text-[15px] font-semibold text-ink">{t}</div>
      <div className="mt-1 text-sm leading-[21px] text-body">{m}</div>
    </Callout>
  );
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function RevealDialog({ credentialId, title, tier, field, previousSecretId, onClose }: { credentialId: string; title: string; tier: Tier; field: string; previousSecretId: string | null; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ k: "loading" });
  const [pw, setPw] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [why, setWhy] = useState("");
  const [whyErr, setWhyErr] = useState(false);
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(0);
  const [planAt, setPlanAt] = useState(0);
  const copiedRef = useRef(false);

  const load = async () => {
    const plan = await planReveal(credentialId, field, previousSecretId);
    setPlanAt(Date.now());
    setStep({ k: "plan", plan });
  };

  useEffect(() => {
    let live = true;
    planReveal(credentialId, field, previousSecretId).then((plan) => {
      if (!live) return;
      setPlanAt(Date.now());
      setStep({ k: "plan", plan });
    });
    return () => {
      live = false;
    };
  }, [credentialId, field, previousSecretId]);

  /* One clock for the countdowns, read in an effect — never during render. */
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  /* Hide the value when its time is up, and wipe the clipboard if we wrote to it. */
  useEffect(() => {
    if (step.k === "revealed" && now >= step.until) {
      if (copiedRef.current) navigator.clipboard?.writeText("").catch(() => {});
      copiedRef.current = false;
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- the countdown reaching zero is an external clock event */
      setStep({ k: "hidden", seconds: Math.round(step.total / 1000) });
    }
  }, [now, step]);

  /* Waiting for a second person: ask the server every few seconds. */
  const waiting = step.k === "plan" && step.plan.step === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const plan = await planReveal(credentialId, field, previousSecretId);
      setPlanAt(Date.now());
      setStep({ k: "plan", plan });
    }, 5000);
    return () => clearInterval(t);
  }, [waiting, credentialId, field, previousSecretId]);

  const close = () => {
    if (copiedRef.current) navigator.clipboard?.writeText("").catch(() => {});
    onClose();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (step.k === "revealed") return;
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [step.k, onClose]);

  const plan = step.k === "plan" ? step.plan : null;
  const reasonMin = plan && "reasonMin" in plan ? plan.reasonMin : 15;
  const whyOk = why.trim().length >= reasonMin;

  const doReveal = async (requestId?: string) => {
    if (!plan || (plan.step !== "confirm" && plan.step !== "stepup")) return;
    if (plan.askReason && !whyOk) return setWhyErr(true);
    setBusy(true);
    const r = await revealSecret({ credentialId, field, previousSecretId, password: plan.step === "stepup" ? pw : undefined, reason: why, requestId: requestId ?? null });
    setBusy(false);
    if (r.ok) {
      setPw("");
      const at = Date.now();
      setStep({ k: "revealed", value: r.data.value, until: at + r.data.showSeconds * 1000, total: r.data.showSeconds * 1000, clip: r.data.clipboardSeconds, watermark: r.data.watermark, field: r.data.field, previous: r.data.previous });
      setNow(at);
      return;
    }
    if (r.fieldErrors?.some((f) => f.field === "password")) {
      const n = tries + 1;
      setTries(n);
      setPw("");
      if (n >= 3) return setStep({ k: "stepfail" });
      return setPwErr(`That password didn’t match · ${3 - n} ${3 - n === 1 ? "attempt" : "attempts"} left`);
    }
    if (r.fieldErrors?.some((f) => f.field === "reason")) return setWhyErr(true);
    setStep({ k: "error", msg: r.error });
  };

  let head = "Reveal secret";
  let body: React.ReactNode = null;
  let btns: React.ReactNode = null;
  const cancel = <Button onClick={close}>Cancel</Button>;
  const closeB = <Button onClick={close}>Close</Button>;
  let ring: { off: number; label: string } | null = null;

  const whyBox = (
    <Field label="Why do you need this?" required>
      <Textarea
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        rows={3}
        invalid={whyErr && !whyOk}
        placeholder="For example: updating the payment webhook after the provider changed keys"
      />
      <span className={cx("mt-1 block text-xs", whyErr && !whyOk ? "text-danger" : "text-muted")}>
        {whyOk ? "Recorded with your name, the time and this item." : `At least ${reasonMin} characters · ${Math.max(0, reasonMin - why.trim().length)} to go`}
      </span>
    </Field>
  );

  if (step.k === "loading") body = <div className="text-sm text-muted">Checking what this needs…</div>;
  else if (step.k === "error") {
    body = <Msg t="Not revealed" m={step.msg} tone="red" />;
    btns = closeB;
  } else if (step.k === "stepfail") {
    head = "Sign-in not confirmed";
    body = <Msg t="Three attempts failed" m="The reveal is blocked and the attempt is recorded. If you have forgotten your password, reset it from MahekOne sign-in, then try again." tone="red" />;
    btns = closeB;
  } else if (step.k === "hidden") {
    head = "Hidden";
    body = <Msg t="The secret is hidden again" m={`It was on screen for ${step.seconds} seconds at most. To see it again, start a new reveal — there is no way to extend one.`} tone="violet" />;
    btns = closeB;
  } else if (step.k === "revealed") {
    head = title;
    const left = Math.max(0, step.until - now);
    ring = { off: RING * (1 - left / step.total), label: `${Math.ceil(left / 1000)}s` };
    const wm = step.watermark;
    body = (
      <div className="flex flex-col gap-3">
        <div className="relative flex min-h-[132px] items-center justify-center overflow-hidden rounded-card border border-line bg-page px-5 py-7">
          <span className="relative z-[1] text-center font-mono text-lg leading-7 tracking-[0.05em] break-all whitespace-pre-wrap text-ink select-all [font-feature-settings:'zero'_1] [font-variant-ligatures:none]">{step.value}</span>
          {wm ? (
            <div aria-hidden className="pointer-events-none absolute -inset-10 z-[2] flex flex-col justify-center gap-[22px] -rotate-[14deg] opacity-[0.16]">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="block text-center text-[13px] font-bold tracking-[0.08em] whitespace-nowrap text-ink">
                  {wm}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {step.clip > 0 ? (
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(step.value);
                  copiedRef.current = true;
                  setCopied(true);
                  noteCopied(credentialId, field).catch(() => {});
                  setTimeout(() => {
                    navigator.clipboard?.writeText("").catch(() => {});
                    copiedRef.current = false;
                  }, step.clip * 1000);
                } catch {
                  /* the browser refused the clipboard */
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
          <span className="text-[13px] text-body">{step.clip > 0 ? `Clipboard clears in ${step.clip}s` : "Copy is disabled for Restricted secrets — read it and type it."}</span>
        </div>
        <div className="text-[13px] text-muted">Hiding in {Math.ceil(left / 1000)} seconds. Revealing again needs the whole flow.</div>
      </div>
    );
    btns = (
      <Button
        variant="primary"
        onClick={() => {
          if (copiedRef.current) navigator.clipboard?.writeText("").catch(() => {});
          copiedRef.current = false;
          setStep({ k: "hidden", seconds: Math.round((now - (step.until - step.total)) / 1000) });
        }}
      >
        Hide now
      </Button>
    );
  } else if (plan) {
    if (plan.step === "novault") {
      body = <Msg t="The vault has no key" m={plan.why} tone="red" />;
      btns = closeB;
    } else if (plan.step === "denied") {
      head = "You can’t reveal this";
      body = (
        <>
          <Msg t="Not available to you" m={plan.why} tone="violet" />
          {plan.who.length ? (
            <div>
              <div className="mb-1.5 text-xs font-medium tracking-label text-muted uppercase">People who can</div>
              {plan.who.slice(0, 6).map((n) => (
                <div key={n} className="flex items-center gap-3 py-1">
                  <span className="h-2.5 w-2.5 rounded-full bg-muted" />
                  <span className="flex-1 text-sm font-medium text-ink">{n}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      );
      btns = closeB;
    } else if (plan.step === "ratelimited") {
      head = "Reveals paused";
      body = <Msg t="You reached the hourly limit" m={plan.why} tone="amber" />;
      btns = (
        <>
          {closeB}
          {plan.canBreakglass ? (
            <Link href="/locker/emergency" className={buttonClass({ variant: "danger" })}>
              Start emergency access
            </Link>
          ) : null}
        </>
      );
    } else if (plan.step === "confirm") {
      body = <div className="text-[13px] leading-[19px] text-body">Standard secret. {plan.notice}</div>;
      btns = (
        <>
          {cancel}
          <Button variant="primary" disabled={busy} onClick={() => doReveal()}>
            {busy ? "Revealing…" : "Reveal"}
          </Button>
        </>
      );
    } else if (plan.step === "stepup") {
      const leftApproval = plan.approvalLeftMs != null ? plan.approvalLeftMs - (now - planAt) : null;
      body = (
        <>
          {plan.approvedBy ? <Msg t={`Approved by ${plan.approvedBy}`} m={`Confirm your password to see it. The approval lapses in ${mmss(leftApproval ?? 0)}.`} tone="green" /> : null}
          <Field label="Confirm it is you" error={pwErr || null}>
            <Input
              type="password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                setPwErr("");
              }}
              placeholder="Your MahekOne password"
              autoComplete="off"
              autoFocus
              invalid={!!pwErr}
              className="h-11 font-mono text-[15px]"
            />
          </Field>
          {plan.askReason ? whyBox : null}
          <div className="text-[13px] leading-[19px] text-body">This reveal will be recorded against your name. {plan.notice}</div>
        </>
      );
      btns = (
        <>
          {cancel}
          <Button variant="primary" disabled={busy || !pw} onClick={() => doReveal(plan.requestId)}>
            {busy ? "Revealing…" : "Reveal"}
          </Button>
        </>
      );
    } else if (plan.step === "request") {
      head = "Approval required";
      body = (
        <>
          <Msg t="Restricted secrets need a second person’s approval" m="Your request will be sent to:" tone="violet" />
          {plan.approvers.length ? (
            plan.approvers.slice(0, 6).map((n) => (
              <div key={n} className="flex items-center gap-3">
                <span className="h-2.5 w-2.5 rounded-full bg-ink" />
                <span className="flex-1 text-sm font-medium text-ink">{n}</span>
                <span className="text-[13px] text-muted">Approvals</span>
              </div>
            ))
          ) : (
            <Msg t="Nobody else can approve" m="Nobody else holds Approvals in the Locker. Ask a Locker admin to give it to a second person." tone="amber" />
          )}
          {whyBox}
          <div className="text-[13px] leading-[19px] text-body">Requests lapse after {plan.approvalMinutes} minutes. Copy to clipboard is disabled for Restricted secrets — read it and type it.</div>
        </>
      );
      btns = (
        <>
          {cancel}
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              if (!whyOk) return setWhyErr(true);
              setBusy(true);
              const r = await requestReveal(credentialId, field, previousSecretId, why);
              setBusy(false);
              if (!r.ok) return setStep({ k: "error", msg: r.error });
              await load();
            }}
          >
            {busy ? "Sending…" : "Request approval"}
          </Button>
        </>
      );
    } else if (plan.step === "waiting") {
      head = "Waiting for approval";
      const left = Math.max(0, plan.leftMs - (now - planAt));
      ring = { off: RING * (1 - left / plan.totalMs), label: mmss(left) };
      body =
        left <= 0 ? (
          <Msg t="No one approved in time" m="The request has closed. Start again if you still need it — your earlier reason is not reused." tone="amber" />
        ) : (
          <>
            <Msg t="Request sent" m="Approval is needed from one of the people below. You can close this window — the request stays open and you are notified when it is decided." tone="violet" />
            {plan.approvers.slice(0, 6).map((n) => (
              <div key={n} className="flex items-center gap-3">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-warn" />
                <span className="flex-1 text-sm font-medium text-ink">{n}</span>
                <span className="text-[13px] text-muted">notified</span>
              </div>
            ))}
          </>
        );
      btns = (
        <>
          <Button
            onClick={async () => {
              await withdrawReveal(plan.requestId);
              close();
            }}
          >
            Withdraw request
          </Button>
          <Button variant="primary" onClick={close}>
            Close — keep waiting
          </Button>
        </>
      );
    } else if (plan.step === "declined") {
      head = "Request declined";
      body = <Msg t={`${plan.by} declined this request`} m={plan.note ? `“${plan.note}”` : "No note was given."} tone="red" />;
      btns = closeB;
    } else if (plan.step === "expired") {
      head = "Request expired";
      body = <Msg t="No one approved in time" m="Start again if you still need it." tone="amber" />;
      btns = closeB;
    }
  }

  const canBackdropClose = step.k !== "revealed" && !(plan && plan.step === "waiting");
  return (
    <div onClick={() => canBackdropClose && close()} className="ui-scrim animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(22,22,22,0.35)] p-6">
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="ui-dialog flex max-h-[88vh] w-[560px] max-w-full flex-col overflow-hidden rounded-[6px] bg-surface whitespace-normal shadow-[0_8px_24px_rgba(22,22,22,0.12)]"
      >
        <div className="ui-dialog-title flex items-start gap-3 border-b border-divider px-5 py-4">
          <span className="mt-0.5 flex text-muted">
            <LkIcon name="key" size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-lg leading-6 font-semibold text-ink">{head}</span>
            <span className="mt-0.5 block text-[13px] text-body">{step.k === "revealed" ? `${step.field}${step.previous ? " · previous value" : ""}` : title}</span>
            <span className="mt-1.5 flex items-center gap-2">
              <TierPill tier={tier} />
              <span className="text-xs text-muted">{step.k === "revealed" ? "Revealed to you" : `${field}${previousSecretId ? " · previous value" : ""}`}</span>
            </span>
          </span>
          {ring ? (
            <span className="flex flex-none items-center gap-2">
              <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden>
                <circle cx="18" cy="18" r="15" fill="none" stroke="var(--color-line)" strokeWidth="3" />
                <circle cx="18" cy="18" r="15" fill="none" stroke="var(--color-ink)" strokeWidth="3" strokeDasharray={String(RING)} strokeDashoffset={String(ring.off)} transform="rotate(-90 18 18)" strokeLinecap="round" />
              </svg>
              <span className="min-w-[34px] text-[15px] font-semibold text-ink">{ring.label}</span>
            </span>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{body}</div>
        <div className="flex justify-end gap-2.5 border-t border-divider px-5 py-3">{btns}</div>
      </div>
    </div>
  );
}
