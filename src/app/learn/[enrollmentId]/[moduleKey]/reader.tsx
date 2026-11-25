"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startAttemptAction, studyBeatAction } from "@/lib/actions/learn";
import type { ModuleState } from "@/lib/training/types";
import { learnBtn } from "../../ui";

const BEAT_SECONDS = 30;

/**
 * The foot of a module: how long has been studied, and the way into the test.
 * Study time counts only while the page is on screen; it is sent every thirty
 * seconds and the server caps each beat, so a tab left open banks nothing much.
 */
export function Reader(p: {
  enrollmentId: string;
  moduleKey: string;
  state: ModuleState;
  studiedSeconds: number;
  minStudyMinutes: number;
  canStart: boolean;
  why: string | null;
  rules: { passMark: number; timerMinutes: number | null; questions: number; feedback: string };
  attempts: number;
  trackDone: boolean;
}) {
  const router = useRouter();
  const [studied, setStudied] = useState(p.studiedSeconds);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const unsent = useRef(0);
  const total = useRef(p.studiedSeconds);
  const studyable = p.state !== "locked" && p.state !== "passed" && !p.trackDone;

  useEffect(() => {
    if (!studyable) return;
    let last = performance.now();
    const tick = () => {
      const t = performance.now();
      const secs = Math.round((t - last) / 1000);
      last = t;
      if (document.visibilityState !== "visible" || secs <= 0) return;
      unsent.current += Math.min(secs, BEAT_SECONDS * 2);
      total.current += Math.min(secs, BEAT_SECONDS * 2);
      setStudied((s) => s + Math.min(secs, BEAT_SECONDS * 2));
    };
    const minSecs = p.minStudyMinutes * 60;
    const retraining = p.state === "retraining_required";
    const flush = () => {
      const s = unsent.current;
      if (s <= 0) return;
      unsent.current = 0;
      const crossed = total.current >= minSecs && total.current - s < minSecs;
      /* Once the minimum is reached the server may open the test or the retake: ask it again. */
      void studyBeatAction(p.enrollmentId, p.moduleKey, s).then(() => {
        /* A signed-off retake opens on study SINCE the fail, which only the server counts. */
        if (crossed || retraining) router.refresh();
      });
    };
    const id = window.setInterval(() => {
      tick();
      flush();
    }, BEAT_SECONDS * 1000);
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        tick();
        flush();
      } else last = performance.now();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      tick();
      flush();
    };
  }, [studyable, p.enrollmentId, p.moduleKey, p.minStudyMinutes, p.state, router]);

  const minSec = p.minStudyMinutes * 60;
  const waitingOnStudy = !p.canStart && (p.state === "available" || p.state === "in_progress") && studied >= minSec;
  const ready = p.canStart || waitingOnStudy || p.state === "assessment_pending";

  const go = () =>
    start(async () => {
      setError(null);
      const s = unsent.current;
      unsent.current = 0;
      if (s > 0) await studyBeatAction(p.enrollmentId, p.moduleKey, s);
      const r = await startAttemptAction(p.enrollmentId, p.moduleKey);
      if (!r.ok) {
        setError(r.error);
        router.refresh();
        return;
      }
      router.push(`/learn/test/${r.data.attemptId}`);
    });

  if (p.trackDone || p.state === "passed")
    return <div className="rounded-[8px] bg-success-soft px-3.5 py-3 text-[13px] text-success">{p.state === "passed" ? "You have passed this module." : "This track is complete."}</div>;

  const label = p.state === "assessment_pending" ? "Carry on with the test" : p.state === "retake_open" ? `Start retake ${p.attempts + 1}` : "Start the test";
  const lockedWhy = p.state === "locked" ? (p.why ?? "This module is locked.") : p.state === "retraining_required" ? "Your trainer signs off the review first, then the retake opens." : !ready ? `Study for ${p.minStudyMinutes} minutes first.` : undefined;

  return (
    <div className="sticky bottom-16 z-10 -mx-4 flex flex-col gap-2 border-t border-line bg-surface px-4 pt-3 pb-3">
      <div className="flex justify-between gap-2 text-[12px] text-muted tabular-nums">
        <span>{minSec ? `Studied ${Math.min(p.minStudyMinutes, Math.floor(studied / 60))} of ${p.minStudyMinutes} min` : "No minimum study time"}</span>
        <span>
          {p.rules.questions} questions{p.rules.timerMinutes ? ` · ${p.rules.timerMinutes} min` : ""} · pass {p.rules.passMark}%
        </span>
      </div>
      {ready && p.state !== "locked" && p.state !== "retraining_required" ? (
        <button type="button" onClick={go} disabled={pending} className={learnBtn("primary", pending)} title={pending ? "Starting…" : undefined}>
          {pending ? "Starting…" : label}
        </button>
      ) : (
        <button type="button" disabled title={lockedWhy} className={learnBtn("primary", true)}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path d="M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          {p.state === "retraining_required" ? "Retake opens after sign-off" : p.state === "locked" ? "Locked" : label}
        </button>
      )}
      {lockedWhy && !ready ? <p className="m-0 text-center text-[12px] text-muted">{lockedWhy}</p> : null}
      {error ? <p className="m-0 text-center text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}
