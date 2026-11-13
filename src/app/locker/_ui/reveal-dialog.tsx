"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { noteCopied, planReveal, requestReveal, revealSecret, withdrawReveal } from "@/lib/actions/locker-vault";
import type { RevealPlan } from "@/lib/locker/vault-core";
import type { Tier } from "@/lib/locker/engine";
import { C, LBL, MONO, TierPill, btnStyle } from "./kit";


/* ---------------------------------------------------------------------------
 * THE REVEAL, as the design draws it: a violet dialog that asks for exactly
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

export function RevealButton({ credentialId, title, tier, field, previousSecretId, label = "Reveal", style }: { credentialId: string; title: string; tier: Tier; field: string; previousSecretId?: string | null; label?: string; style?: CSSProperties }) {
  const [open, setOpen] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setOpen(Date.now())} style={style ?? { height: 34, padding: "0 16px", border: "none", background: C.v700, borderRadius: 4, color: "#FFFFFF", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
        {label}
      </button>
      {open ? <RevealDialog key={open} credentialId={credentialId} title={title} tier={tier} field={field} previousSecretId={previousSecretId ?? null} onClose={() => setOpen(0)} /> : null}
    </>
  );
}

function Msg({ t, m, tone }: { t: string; m: React.ReactNode; tone: "red" | "amber" | "green" | "violet" }) {
  const bg = tone === "red" ? "#FCECEC" : tone === "amber" ? "#FDF6E7" : tone === "green" ? "#E9F5EE" : C.v50;
  const fg = tone === "red" ? "#8E1F1F" : tone === "amber" ? "#8A5C05" : tone === "green" ? "#1D7A45" : C.v900;
  return (
    <div style={{ padding: "14px 16px", borderRadius: 6, background: bg, color: fg }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{t}</div>
      <div style={{ fontSize: 14, lineHeight: "21px", marginTop: 4 }}>{m}</div>
    </div>
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
  const cancel = (
    <button type="button" onClick={close} style={btnStyle("s")}>
      Cancel
    </button>
  );
  const closeB = (
    <button type="button" onClick={close} style={btnStyle("s")}>
      Close
    </button>
  );
  let ring: { off: number; label: string } | null = null;

  const whyBox = (
    <label style={{ display: "block" }}>
      <span style={{ display: "flex", justifyContent: "space-between", ...LBL, marginBottom: 6 }}>
        <span>Why do you need this?</span>
        <span>required</span>
      </span>
      <textarea
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        rows={3}
        placeholder="For example: updating the payment webhook after the provider changed keys"
        style={{ width: "100%", padding: "10px 12px", border: `1px solid ${whyErr && !whyOk ? C.red : "#C2C8D2"}`, borderRadius: 4, fontSize: 14, lineHeight: "20px", resize: "vertical" }}
      />
      <span style={{ display: "block", fontSize: 12, marginTop: 4, color: whyErr && !whyOk ? C.red : C.muted }}>
        {whyOk ? "Recorded with your name, the time and this item." : `At least ${reasonMin} characters · ${Math.max(0, reasonMin - why.trim().length)} to go`}
      </span>
    </label>
  );

  if (step.k === "loading") body = <div style={{ fontSize: 14, color: C.muted }}>Checking what this needs…</div>;
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
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ position: "relative", overflow: "hidden", border: `1px solid ${C.v100}`, borderRadius: 6, background: C.canvas, padding: "28px 20px", minHeight: 132, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ position: "relative", zIndex: 1, fontFamily: MONO, fontSize: 18, lineHeight: "28px", letterSpacing: "0.05em", color: C.v900, wordBreak: "break-all", textAlign: "center", userSelect: "all", fontVariantLigatures: "none", fontFeatureSettings: "'zero' 1", whiteSpace: "pre-wrap" }}>{step.value}</span>
          {wm ? (
            <div aria-hidden style={{ position: "absolute", inset: -40, zIndex: 2, pointerEvents: "none", display: "flex", flexDirection: "column", justifyContent: "center", gap: 22, transform: "rotate(-14deg)", opacity: 0.16 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} style={{ display: "block", whiteSpace: "nowrap", fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", color: C.v900, textAlign: "center" }}>
                  {wm}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {step.clip > 0 ? (
            <button
              type="button"
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
              style={{ height: 34, padding: "0 14px", border: `1px solid ${C.v700}`, background: "#FFFFFF", borderRadius: 4, color: C.v700, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
          <span style={{ fontSize: 13, color: C.v700 }}>{step.clip > 0 ? `Clipboard clears in ${step.clip}s` : "Copy is disabled for Restricted secrets — read it and type it."}</span>
        </div>
        <div style={{ fontSize: 13, color: C.muted }}>Hiding in {Math.ceil(left / 1000)} seconds. Revealing again needs the whole flow.</div>
      </div>
    );
    btns = (
      <button
        type="button"
        onClick={() => {
          if (copiedRef.current) navigator.clipboard?.writeText("").catch(() => {});
          copiedRef.current = false;
          setStep({ k: "hidden", seconds: Math.round((now - (step.until - step.total)) / 1000) });
        }}
        style={btnStyle("v")}
      >
        Hide now
      </button>
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
              <div style={{ ...LBL, marginBottom: 6 }}>People who can</div>
              {plan.who.slice(0, 6).map((n) => (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 0" }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: C.v500 }} />
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: C.ink }}>{n}</span>
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
            <Link href="/locker/emergency" style={btnStyle("d")}>
              Start emergency access
            </Link>
          ) : null}
        </>
      );
    } else if (plan.step === "confirm") {
      body = <div style={{ fontSize: 13, lineHeight: "19px", color: C.v700 }}>Standard secret. {plan.notice}</div>;
      btns = (
        <>
          {cancel}
          <button type="button" disabled={busy} onClick={() => doReveal()} style={btnStyle("v")}>
            {busy ? "Revealing…" : "Reveal"}
          </button>
        </>
      );
    } else if (plan.step === "stepup") {
      const leftApproval = plan.approvalLeftMs != null ? plan.approvalLeftMs - (now - planAt) : null;
      body = (
        <>
          {plan.approvedBy ? <Msg t={`Approved by ${plan.approvedBy}`} m={`Confirm your password to see it. The approval lapses in ${mmss(leftApproval ?? 0)}.`} tone="green" /> : null}
          <label style={{ display: "block" }}>
            <span style={{ display: "block", ...LBL, marginBottom: 6 }}>Confirm it is you</span>
            <input
              type="password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                setPwErr("");
              }}
              placeholder="Your MahekOne password"
              autoComplete="off"
              autoFocus
              style={{ width: "100%", height: 44, padding: "0 12px", border: `1px solid ${pwErr ? C.red : "#C2C8D2"}`, borderRadius: 4, fontSize: 15, fontFamily: MONO }}
            />
            {pwErr ? <span style={{ display: "block", fontSize: 12, color: C.red, marginTop: 4 }}>{pwErr}</span> : null}
          </label>
          {plan.askReason ? whyBox : null}
          <div style={{ fontSize: 13, lineHeight: "19px", color: C.v700 }}>This reveal will be recorded against your name. {plan.notice}</div>
        </>
      );
      btns = (
        <>
          {cancel}
          <button type="button" disabled={busy || !pw} onClick={() => doReveal(plan.requestId)} style={pw ? btnStyle("v") : { ...btnStyle("v"), opacity: 0.5, cursor: "not-allowed" }}>
            {busy ? "Revealing…" : "Reveal"}
          </button>
        </>
      );
    } else if (plan.step === "request") {
      head = "Approval required";
      body = (
        <>
          <Msg t="Restricted secrets need a second person’s approval" m="Your request will be sent to:" tone="violet" />
          {plan.approvers.length ? (
            plan.approvers.slice(0, 6).map((n) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: C.v700 }} />
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: C.ink }}>{n}</span>
                <span style={{ fontSize: 13, color: C.muted }}>Approvals</span>
              </div>
            ))
          ) : (
            <Msg t="Nobody else can approve" m="Nobody else holds Approvals in the Locker. Ask a Locker admin to give it to a second person." tone="amber" />
          )}
          {whyBox}
          <div style={{ fontSize: 13, lineHeight: "19px", color: C.v700 }}>Requests lapse after {plan.approvalMinutes} minutes. Copy to clipboard is disabled for Restricted secrets — read it and type it.</div>
        </>
      );
      btns = (
        <>
          {cancel}
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!whyOk) return setWhyErr(true);
              setBusy(true);
              const r = await requestReveal(credentialId, field, previousSecretId, why);
              setBusy(false);
              if (!r.ok) return setStep({ k: "error", msg: r.error });
              await load();
            }}
            style={btnStyle("v")}
          >
            {busy ? "Sending…" : "Request approval"}
          </button>
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
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#B77B08", animation: "lk-pulse 1.4s ease-in-out infinite" }} />
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: C.ink }}>{n}</span>
                <span style={{ fontSize: 13, color: C.muted }}>notified</span>
              </div>
            ))}
          </>
        );
      btns = (
        <>
          <button
            type="button"
            onClick={async () => {
              await withdrawReveal(plan.requestId);
              close();
            }}
            style={btnStyle("s")}
          >
            Withdraw request
          </button>
          <button type="button" onClick={close} style={btnStyle("v")}>
            Close — keep waiting
          </button>
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
    <div onClick={() => canBackdropClose && close()} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(38,32,65,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: "100%", maxHeight: "calc(100vh - 48px)", background: "#FFFFFF", borderRadius: 6, boxShadow: "0 16px 48px rgba(38,32,65,0.24)", display: "flex", flexDirection: "column", overflow: "hidden", animation: "lk-reveal 300ms cubic-bezier(0.2,0,0.2,1)" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 24px", background: C.v50, borderBottom: `1px solid ${C.v100}` }}>
          <span style={{ color: C.v700, fontSize: 18, lineHeight: "24px" }}>◈</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 18, lineHeight: "24px", fontWeight: 600, color: C.v900 }}>{head}</span>
            <span style={{ display: "block", fontSize: 13, color: C.v700, marginTop: 2 }}>{step.k === "revealed" ? `${step.field}${step.previous ? " · previous value" : ""}` : title}</span>
            <span style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
              <TierPill tier={tier} />
              <span style={{ fontSize: 12, color: C.v500 }}>{step.k === "revealed" ? "Revealed to you" : `${field}${previousSecretId ? " · previous value" : ""}`}</span>
            </span>
          </span>
          {ring ? (
            <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
              <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden>
                <circle cx="18" cy="18" r="15" fill="none" stroke={C.v100} strokeWidth="3" />
                <circle cx="18" cy="18" r="15" fill="none" stroke={C.v700} strokeWidth="3" strokeDasharray={String(RING)} strokeDashoffset={String(ring.off)} transform="rotate(-90 18 18)" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 15, fontWeight: 600, color: C.v900, minWidth: 34 }}>{ring.label}</span>
            </span>
          ) : null}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>{body}</div>
        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.v100}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>{btns}</div>
      </div>
    </div>
  );
}
