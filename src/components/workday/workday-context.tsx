"use client";

import * as React from "react";
import type { WorkdayState } from "@/lib/hrms/services/workday";
import { WorkdayOverlays } from "./workday-overlays";

/* ---------------------------------------------------------------------------
 * THE WORKDAY CLOCK IN THE BROWSER. One provider, mounted by `AppFrame` (so
 * every app has it) and by the launcher. It reads the day from
 * `/api/workday`, keeps the timer ticking locally, watches for activity, and
 * draws the lock, the idle warning and the return screens.
 *
 * ACTIVITY is a mouse move, a key, a scroll, a click or a touch in ANY
 * MahekOne tab: tabs share the newest moment through a BroadcastChannel and
 * localStorage, so somebody working in the CRM is not called idle by the ERP
 * tab behind it. An open call drawer (`data-workday-busy`) counts too — a
 * telecaller on a long call is working with the mouse still. The server
 * hears about it at most once a minute (a heartbeat), and decides.
 * ------------------------------------------------------------------------- */

export type WorkdayOp =
  | { op: "punchIn" | "punchOut"; lat?: number | null; lng?: number | null; accuracy?: number | null }
  | { op: "break"; reason?: string | null }
  | { op: "resume"; claim?: { category: string; note: string } | null }
  | { op: "claimOut"; category: string; note: string }
  | { op: "lateHelp"; text: string }
  | { op: "beat" };

export type OpResult = { ok: boolean; error?: string; message?: string; refusal?: string; detail?: string };

type Ctx = {
  state: WorkdayState;
  /** Ms, ticking once a second. */
  now: number;
  /** The newest activity in any tab, ms. */
  lastActivity: number;
  workedMs: number;
  act: (op: WorkdayOp) => Promise<OpResult>;
  refresh: () => Promise<void>;
  touch: () => void;
  busy: boolean;
};

const WorkdayContext = React.createContext<Ctx | null>(null);

export function useWorkday(): Ctx | null {
  return React.useContext(WorkdayContext);
}

const CHANNEL = "mahek-workday";
const ACT_KEY = "mahek.workday.lastActivity";
const BEAT_KEY = "mahek.workday.lastBeat";
const BEAT_EVERY = 60_000;

function readNum(key: string): number {
  try {
    return Number(window.localStorage.getItem(key) ?? 0) || 0;
  } catch {
    return 0;
  }
}
function writeNum(key: string, v: number) {
  try {
    window.localStorage.setItem(key, String(v));
  } catch {
    /* private window: this tab keeps its own */
  }
}

function unwrap(result: unknown): OpResult {
  const r = result as { ok?: boolean; error?: string; message?: string; data?: { refusal?: string; message?: string; detail?: string } } | null;
  if (!r) return { ok: true };
  if (r.ok === false) return { ok: false, error: r.error ?? "That did not work." };
  if (r.data?.refusal) return { ok: false, refusal: r.data.refusal, error: r.data.message, detail: r.data.detail };
  return { ok: true, message: r.message };
}

export function WorkdayProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<WorkdayState | null>(null);
  const [now, setNow] = React.useState(0);
  const [lastActivity, setLastActivity] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  /* The server's clock against the browser's, so the timer reads the server's minute. */
  const [skew, setSkew] = React.useState(0);
  const channel = React.useRef<BroadcastChannel | null>(null);
  const lastAct = React.useRef(0);

  const load = React.useCallback((s: WorkdayState) => {
    setSkew(s.now - Date.now());
    setState(s);
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/workday", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { state?: WorkdayState };
      if (j.state) load(j.state);
    } catch {
      /* offline: keep what we have and try again on the next tick */
    }
  }, [load]);

  const act = React.useCallback(
    async (op: WorkdayOp): Promise<OpResult> => {
      setBusy(true);
      try {
        const res = await fetch("/api/workday", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) });
        const j = (await res.json().catch(() => ({}))) as { state?: WorkdayState; result?: unknown; error?: string };
        if (j.state) load(j.state);
        if (!res.ok) return { ok: false, error: j.error ?? "That did not work. Try again." };
        return unwrap(j.result);
      } catch {
        return { ok: false, error: "MahekOne could not be reached. Check the connection and try again." };
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const sendBeat = React.useCallback(async () => {
    writeNum(BEAT_KEY, Date.now());
    try {
      await fetch("/api/workday", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "beat" }) });
    } catch {
      /* the next minute tries again */
    }
  }, []);

  const touch = React.useCallback(() => {
    const t = Date.now();
    if (t - lastAct.current < 1_000) return;
    lastAct.current = t;
    setLastActivity(t);
    writeNum(ACT_KEY, t);
    channel.current?.postMessage({ t });
  }, []);

  /* First read, the shared channel and the activity listeners. */
  React.useEffect(() => {
    lastAct.current = Math.max(readNum(ACT_KEY), Date.now());
    setLastActivity(lastAct.current);
    setNow(Date.now());
    void refresh();
    try {
      channel.current = new BroadcastChannel(CHANNEL);
      channel.current.onmessage = (e: MessageEvent<{ t?: number; refresh?: boolean }>) => {
        if (e.data?.t && e.data.t > lastAct.current) {
          lastAct.current = e.data.t;
          setLastActivity(e.data.t);
        }
        if (e.data?.refresh) void refresh();
      };
    } catch {
      channel.current = null;
    }
    const on = () => touch();
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, on, { passive: true, capture: true }));
    const vis = () => {
      if (document.visibilityState === "visible") {
        touch();
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", vis);
    return () => {
      events.forEach((e) => window.removeEventListener(e, on, { capture: true }));
      document.removeEventListener("visibilitychange", vis);
      channel.current?.close();
    };
  }, [refresh, touch]);

  /* The tick: the timer, the busy markers, the heartbeat and the poll. */
  React.useEffect(() => {
    let polls = 0;
    const id = window.setInterval(() => {
      setNow(Date.now());
      if (document.querySelector("[data-workday-busy]")) touch();
      const shared = readNum(ACT_KEY);
      if (shared > lastAct.current) {
        lastAct.current = shared;
        setLastActivity(shared);
      }
      if (!state?.subject) return;
      if (state.phase === "working" && lastAct.current > readNum(BEAT_KEY) && Date.now() - readNum(BEAT_KEY) >= BEAT_EVERY) void sendBeat();
      polls++;
      /* Every minute, and at once when the idle clock would have crossed a line. */
      const idle = Date.now() - lastAct.current;
      const crossing = state.phase === "working" && idle >= state.cfg.breakMinutes * 60_000 && idle < state.cfg.breakMinutes * 60_000 + 1_000;
      if (polls % 60 === 0 || crossing) void refresh();
    }, 1_000);
    return () => window.clearInterval(id);
  }, [state, refresh, sendBeat, touch]);

  /* Every other tab re-reads the day when this one changes it. */
  const actAndTell = React.useCallback(
    async (op: WorkdayOp) => {
      const r = await act(op);
      channel.current?.postMessage({ refresh: true });
      return r;
    },
    [act],
  );
  const touchAndBeat = React.useCallback(() => {
    touch();
    void sendBeat();
  }, [touch, sendBeat]);

  const value = React.useMemo<Ctx | null>(() => {
    if (!state) return null;
    const t = now ? now + skew : state.now;
    const open = state.sessions[state.sessions.length - 1];
    const running = open && open.out == null ? Math.max(0, t - open.in) : 0;
    const closed = state.sessions.reduce((n, s) => n + (s.out != null ? Math.max(0, s.out - s.in) : 0), 0);
    /* The server's figure includes approved claims; the local one ticks. */
    const extraApproved = Math.max(0, state.workedMs - closed - (open && open.out == null ? Math.max(0, state.now - open.in) : 0));
    return {
      state,
      now: t,
      lastActivity: Math.max(lastActivity, state.lastActivity ?? 0),
      workedMs: closed + running + extraApproved,
      act: actAndTell,
      refresh,
      touch: touchAndBeat,
      busy,
    };
  }, [state, now, skew, lastActivity, actAndTell, refresh, touchAndBeat, busy]);

  return (
    <WorkdayContext.Provider value={value}>
      {children}
      {state?.subject ? <WorkdayOverlays /> : null}
    </WorkdayContext.Provider>
  );
}
