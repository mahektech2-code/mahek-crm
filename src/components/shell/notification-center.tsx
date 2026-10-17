"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { markNotificationRead, markNotificationsRead } from "@/lib/actions/crm";
import {
  ANNOUNCED_KEY,
  PREF_DESKTOP,
  PREF_SOUND,
  ago,
  arrivals,
  dwellMs,
  pruneAnnounced,
  soundOn,
  splitForDisplay,
  toneOf,
  type FeedAnswer,
  type FeedItem,
  type NotifyTone,
} from "@/lib/notification-feed";
import { playChime, primeAudio } from "@/lib/notification-sound";
import { appFor } from "@/lib/app-routes";
import { shownIn, type AppUnread } from "@/lib/notification-apps";
import { cx } from "@/components/ui/primitives";
import { Icon } from "./icons";

/* ---------------------------------------------------------------------------
 * THE LIVE BELL — one per tab, mounted in the root layout so every app gets
 * it: the CRM, Accounts, the Sales Dashboard, the Founder desk, all of them.
 *
 * It asks `/api/notifications` on a cadence, keeps the answer in a small store
 * the header bells read, and for whatever is NEW:
 *
 *   1. slides a pop-up in from the right edge into the bottom right-hand
 *      corner, where it waits a few seconds — for as long as the pointer is
 *      on it — and then slides back out to the right;
 *   2. chimes — on by default, one switch to turn it off, remembered per
 *      browser;
 *   3. where the tab is in the background and the person has allowed it,
 *      raises a desktop notification, so a telecaller on another tab still
 *      hears about the declined order.
 *
 * The chime and the desktop alert are CLAIMED once per notification across
 * every tab of the browser (`ANNOUNCED_KEY`), so four open tabs are one
 * chime, not four. The visual pop-up is drawn in any tab that sees it,
 * because the tab somebody is looking at is the one that has to show it.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------ store */

/**
 * One answer, for the app the tab is showing. `forApp` is which app it was
 * asked for, so a bell drawn a moment after the tab moved from the CRM to the
 * ERP does not paint the CRM's list under the ERP's header.
 */
type FeedState = {
  items: FeedItem[] | null;
  unread: number | null;
  all: FeedItem[] | null;
  byApp: AppUnread[] | null;
  forApp: string | null | undefined;
};

const EMPTY: FeedState = { items: null, unread: null, all: null, byApp: null, forApp: undefined };
let state: FeedState = EMPTY;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getSnapshot = () => state;
const SERVER_STATE: FeedState = EMPTY;
const getServerSnapshot = () => SERVER_STATE;

function setFeed(next: FeedState) {
  state = next;
  emit();
}

/** Ask the centre to fetch now — after a read, or anything that may have written one. */
export function refreshNotifications() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mahek:notifications-refresh"));
}

/**
 * Marks read locally at once, so the badge falls before the server answers.
 * `hits` says which rows: one id, or every row of an app's view.
 */
function markLocal(hits: (n: FeedItem) => boolean) {
  if (!state.items) return;
  const mark = (rows: FeedItem[] | null) => rows?.map((n) => (hits(n) ? { ...n, read: true } : n)) ?? null;
  const items = mark(state.items)!;
  const fell = new Map<string | null, number>();
  const seen = new Set<string>();
  for (const n of [...state.items, ...(state.all ?? [])]) {
    if (n.read || seen.has(n.id) || !hits(n)) continue;
    seen.add(n.id);
    fell.set(n.app, (fell.get(n.app) ?? 0) + 1);
  }
  const byApp = state.byApp?.map((r) => ({ ...r, unread: Math.max(0, r.unread - (fell.get(r.app) ?? 0)) })) ?? null;
  const dropped = [...fell.entries()]
    .filter(([app]) => state.forApp == null || app === null || app === state.forApp)
    .reduce((t, [, c]) => t + c, 0);
  setFeed({ ...state, items, all: mark(state.all), byApp, unread: Math.max(0, (state.unread ?? 0) - dropped) });
}

export async function readOne(id: string) {
  markLocal((n) => n.id === id);
  await markNotificationRead(id);
  refreshNotifications();
}

/**
 * Every notification in a view read: one app's (and the general ones), or —
 * with `app` null — every app's.
 */
export async function readAll(app: string | null = null) {
  if (app === null) {
    markLocal(() => true);
    setFeed({ ...state, unread: 0, byApp: state.byApp?.map((r) => ({ ...r, unread: 0 })) ?? null });
  } else {
    markLocal((n) => shownIn(n.app, app));
  }
  await markNotificationsRead(app);
  refreshNotifications();
}

/**
 * What a header bell draws: the live list once the centre has an answer, and
 * until then the list its layout rendered on the server.
 */
export function useNotificationFeed(initial: FeedItem[], viewApp: string | null) {
  const live = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const fresh = live.items !== null && live.forApp === viewApp;
  const mine = initial.filter((n) => shownIn(n.app, viewApp));
  const items = fresh ? live.items! : mine;
  const all = fresh ? (live.all ?? live.items!) : initial;
  const unread = fresh ? (live.unread ?? 0) : mine.filter((n) => !n.read).length;
  const byApp: AppUnread[] = fresh
    ? (live.byApp ?? [])
    : [...initial.reduce((m, n) => (n.read ? m : m.set(n.app, (m.get(n.app) ?? 0) + 1)), new Map<string | null, number>())].map(
        ([app, c]) => ({ app, unread: c }),
      );
  return { items, unread, all, byApp };
}

/* ------------------------------------------------------------ preferences */

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private window: the choice lasts this tab only */
  }
  window.dispatchEvent(new Event("mahek:notify-prefs"));
}

function subscribePrefs(l: () => void) {
  window.addEventListener("mahek:notify-prefs", l);
  window.addEventListener("storage", l);
  return () => {
    window.removeEventListener("mahek:notify-prefs", l);
    window.removeEventListener("storage", l);
  };
}

/** Sound on unless turned off; desktop alerts only if allowed AND not switched off. */
export function useNotifyPrefs() {
  const sound = React.useSyncExternalStore(
    subscribePrefs,
    () => soundOn(readPref(PREF_SOUND)),
    () => true,
  );
  const permission = React.useSyncExternalStore(
    subscribePrefs,
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
    () => "default",
  );
  const desktopPref = React.useSyncExternalStore(
    subscribePrefs,
    () => readPref(PREF_DESKTOP) !== "off",
    () => true,
  );
  return {
    sound,
    setSound(on: boolean) {
      writePref(PREF_SOUND, on ? "on" : "off");
      if (on) {
        primeAudio();
        playChime("info");
      }
    },
    /** "unsupported" | "default" | "granted" | "denied" */
    permission,
    desktop: permission === "granted" && desktopPref,
    async setDesktop(on: boolean) {
      if (!on) return writePref(PREF_DESKTOP, "off");
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "default") {
        try {
          await Notification.requestPermission();
        } catch {
          /* old Safari: callback form only; ignore */
        }
      }
      writePref(PREF_DESKTOP, "on");
    },
  };
}

/* ---------------------------------------------------------- announcements */

function announcedMap(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(ANNOUNCED_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

/** True for exactly one tab per notification — that tab chimes and alerts. */
function claim(id: string): boolean {
  try {
    const map = announcedMap();
    if (map[id]) return false;
    map[id] = Date.now();
    window.localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(pruneAnnounced(map)));
    return true;
  } catch {
    return true;
  }
}

/* ----------------------------------------------------------------- polling */

const VISIBLE_EVERY_MS = 15_000;
const HIDDEN_EVERY_MS = 30_000;
const SIGNED_OUT_EVERY_MS = 60_000;

type Pop = {
  key: string;
  item: FeedItem;
  tone: NotifyTone;
  /** How many more arrived with it and were not flown separately. */
  more: number;
  /** Arrived while the tab was hidden: fly it in when they come back. */
  waiting: boolean;
  delayMs: number;
};

export function NotificationCenter() {
  const router = useRouter();
  const pathname = usePathname();
  /* The app this tab is showing. The list, the badge and what pops are that
     app's (and the general ones); a CRM decision does not pop over the ERP. */
  const viewApp = pathname ? appFor(pathname) : null;
  const appRef = React.useRef(viewApp);
  const [pops, setPops] = React.useState<Pop[]>([]);
  const known = React.useRef<Set<string> | null>(null);
  const signedOut = React.useRef(false);
  const inFlight = React.useRef(false);

  const announce = React.useCallback((answer: FeedAnswer) => {
    const announced = new Set(Object.keys(announcedMap()));
    const fresh = arrivals(answer, known.current, announced);
    known.current = new Set(answer.items.map((n) => n.id));
    setFeed({
      items: answer.items,
      unread: answer.unread,
      all: answer.all ?? answer.items,
      byApp: answer.byApp ?? [],
      forApp: appRef.current,
    });
    if (!fresh.length) return;

    const hidden = document.visibilityState === "hidden";
    const { show, more } = splitForDisplay(fresh);
    const sound = soundOn(readPref(PREF_SOUND));
    const desktop =
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      readPref(PREF_DESKTOP) !== "off";

    // One chime per batch, in the tone of the most serious thing in it.
    let chimeTone: NotifyTone | null = null;
    const rank: Record<NotifyTone, number> = { info: 0, success: 1, warn: 2, danger: 3 };
    for (const n of fresh) {
      if (!claim(n.id)) continue;
      const t = toneOf(n.kind);
      if (chimeTone === null || rank[t] > rank[chimeTone]) chimeTone = t;
      if (hidden && desktop) {
        try {
          const sys = new Notification(n.title, { body: n.body, tag: n.id, icon: "/favicon.ico" });
          sys.onclick = () => {
            window.focus();
            void readOne(n.id);
            if (n.href) router.push(n.href);
            sys.close();
          };
        } catch {
          /* some mobile browsers only allow this from a service worker */
        }
      }
    }
    if (chimeTone && sound) playChime(chimeTone);

    setPops((current) => {
      const already = new Set(current.map((p) => p.item.id));
      const added = show
        .filter((n) => !already.has(n.id))
        .map((n, i, arr) => ({
          key: `${n.id}`,
          item: n,
          tone: toneOf(n.kind),
          more: i === arr.length - 1 ? more : 0,
          waiting: hidden,
          delayMs: i * 450,
        }));
      // At most five in the corner; the oldest make room.
      return [...current, ...added].slice(-5);
    });
  }, [router]);

  const poll = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const asked = appRef.current;
      const url = asked ? `/api/notifications?app=${encodeURIComponent(asked)}` : "/api/notifications";
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (res.status === 401) {
        signedOut.current = true;
        known.current = null;
        setFeed(EMPTY);
        return;
      }
      if (!res.ok) return;
      signedOut.current = false;
      const answer = (await res.json()) as FeedAnswer;
      /* The tab moved to another app while this was in flight: the answer is
         about the app it left, and the next poll asks the right one. */
      if (asked !== appRef.current) return;
      announce(answer);
    } catch {
      /* offline for a moment: the next tick asks again */
    } finally {
      inFlight.current = false;
    }
  }, [announce]);

  // The cadence: quick while looked at, slower in the background, slowest
  // when nobody is signed in (the sign-in page shares this root layout).
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const every = signedOut.current
        ? SIGNED_OUT_EVERY_MS
        : document.visibilityState === "hidden"
          ? HIDDEN_EVERY_MS
          : VISIBLE_EVERY_MS;
      timer = setTimeout(async () => {
        await poll();
        schedule();
      }, every);
    };
    void poll().then(schedule);
    const now = () => void poll();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setPops((p) => (p.some((x) => x.waiting) ? p.map((x) => ({ ...x, waiting: false })) : p));
        void poll();
      }
    };
    window.addEventListener("mahek:notifications-refresh", now);
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mahek:notifications-refresh", now);
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  // A new page after signing in is the moment to stop being "signed out".
  React.useEffect(() => {
    if (signedOut.current) void poll();
  }, [pathname, poll]);

  /* Moving into another app asks for ITS list at once. `known` starts again,
     so what pops on arrival is only what is fresh and was never announced —
     a notification that came for this app while the tab was elsewhere, not
     the app's whole history. */
  React.useEffect(() => {
    if (appRef.current === viewApp) return;
    appRef.current = viewApp;
    known.current = null;
    void poll();
  }, [viewApp, poll]);

  // A browser lets audio start only from a gesture; the first one unlocks it.
  React.useEffect(() => {
    const unlock = () => primeAudio();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const dismiss = React.useCallback((key: string) => {
    setPops((p) => p.filter((x) => x.key !== key));
  }, []);

  /* The factory app is a phone screen of its own, with its own toasts; a
     desktop pop-up over a scan screen covers the one button that matters. */
  const onSignIn = pathname?.startsWith("/login") || pathname?.startsWith("/factory");
  if (onSignIn || !pops.length) return null;

  return (
    <div
      role="region"
      aria-label="New notifications"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-[95] flex w-[380px] max-w-[calc(100vw-32px)] flex-col gap-2.5"
    >
      {pops.map((p) => (
        <NotificationPopup
          key={p.key}
          pop={p}
          onDismiss={dismiss}
          onOpen={async () => {
            dismiss(p.key);
            await readOne(p.item.id);
            if (p.item.href) router.push(p.item.href);
          }}
          onRead={async () => {
            dismiss(p.key);
            await readOne(p.item.id);
          }}
          onReadAll={async () => {
            setPops([]);
            await readAll(appRef.current);
          }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- popup */

const TONE_STYLE: Record<NotifyTone, { bar: string; chip: string; label: string }> = {
  info: { bar: "bg-brand", chip: "bg-brand-soft text-brand", label: "Notification" },
  success: { bar: "bg-success", chip: "bg-success-soft text-success", label: "Good news" },
  warn: { bar: "bg-warn", chip: "bg-warn-soft text-warn-ink", label: "Needs a look" },
  danger: { bar: "bg-danger", chip: "bg-danger-soft text-danger", label: "Needs you" },
};

function NotificationPopup({
  pop,
  onDismiss,
  onOpen,
  onRead,
  onReadAll,
}: {
  pop: Pop;
  /** Stable, and takes the key — a fresh closure per render would re-arm every card's clock. */
  onDismiss: (key: string) => void;
  onOpen: () => void;
  onRead: () => void;
  onReadAll: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  const [landed, setLanded] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const [nowMs, setNowMs] = React.useState<number | null>(null);
  const prefs = useNotifyPrefs();
  const style = TONE_STYLE[pop.tone];
  const dwell = dwellMs(pop.tone);
  // It slides in from the right edge straight into its slot in the corner.
  const SLIDE_IN_MS = 420;
  const SLIDE_OUT_MS = 320;

  // Out to the right, then gone. A timer rather than `animationend`, because
  // under reduced motion there is no animation to end and the card would stay.
  const leave = React.useCallback(
    (then?: () => void) => {
      setLeaving(true);
      setTimeout(() => {
        onDismiss(pop.key);
        then?.();
      }, SLIDE_OUT_MS);
    },
    [onDismiss, pop.key],
  );

  // Landed once the slide is over; the dwell clock starts there.
  React.useEffect(() => {
    if (pop.waiting) return;
    const t = setTimeout(() => setLanded(true), SLIDE_IN_MS + pop.delayMs);
    return () => clearTimeout(t);
  }, [pop.waiting, pop.delayMs]);

  // After its dwell it slides back out to the right — never while the
  // pointer is on it; leaving the card starts the clock again.
  React.useEffect(() => {
    if (!landed || hover || leaving) return;
    const t = setTimeout(() => leave(), dwell);
    return () => clearTimeout(t);
  }, [landed, hover, leaving, dwell, leave]);

  // "just now" moves on while it sits there.
  React.useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);

  const n = pop.item;
  return (
    <div
      role="status"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ animationDelay: `${pop.delayMs}ms` }}
      className={cx(
        "notify-popup pointer-events-auto relative overflow-hidden rounded-[8px] border border-line bg-surface",
        pop.waiting ? "invisible" : leaving ? "notify-out" : "notify-in",
        "shadow-[0_8px_24px_rgba(22,22,22,0.16)]",
      )}
    >
      <span className={cx("absolute inset-y-0 left-0 w-1", style.bar)} aria-hidden />
      <div className="flex items-start gap-3 py-3 pr-3 pl-4">
        <span className={cx("mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full", style.chip)}>
          <Icon name={pop.tone === "danger" || pop.tone === "warn" ? "alert" : "bell"} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cx("rounded-[3px] px-1.5 py-px text-[11px] font-medium", style.chip)}>{style.label}</span>
            <span className="text-[11px] text-muted">{nowMs === null ? "" : ago(n.createdAt, nowMs)}</span>
          </div>
          <button
            type="button"
            onClick={() => leave(onOpen)}
            className="mt-1 block w-full cursor-pointer text-left"
          >
            <span className="block text-[15px] leading-5 font-medium text-ink">{n.title}</span>
            {n.body ? (
              <span className="mt-0.5 line-clamp-3 block text-[13px] leading-[18px] text-body">{n.body}</span>
            ) : null}
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            {n.href ? (
              <button type="button" onClick={() => leave(onOpen)} className="cursor-pointer font-medium text-brand hover:underline">
                Open
              </button>
            ) : null}
            <button type="button" onClick={() => leave(onRead)} className="cursor-pointer text-muted hover:text-body">
              Mark read
            </button>
            {pop.more > 0 ? (
              <button type="button" onClick={onReadAll} className="cursor-pointer text-muted hover:text-body">
                +{pop.more} more · mark all read
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-none flex-col items-center gap-1">
          <button
            type="button"
            onClick={() => leave()}
            aria-label="Dismiss"
            title="Dismiss — it stays in the bell"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
          >
            <Icon name="close" size={14} />
          </button>
          <button
            type="button"
            onClick={() => prefs.setSound(!prefs.sound)}
            aria-label={prefs.sound ? "Turn notification sound off" : "Turn notification sound on"}
            title={prefs.sound ? "Sound on — click to mute" : "Sound off — click to turn on"}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
          >
            <SpeakerIcon on={prefs.sound} />
          </button>
        </div>
      </div>
      {landed ? (
        <span
          aria-hidden
          className={cx("notify-dwell absolute bottom-0 left-0 h-[2px] opacity-60", style.bar)}
          style={{ animationDuration: `${dwell}ms`, animationPlayState: hover ? "paused" : "running" }}
        />
      ) : null}
    </div>
  );
}

export function SpeakerIcon({ on, size = 14 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" />
      {on ? (
        <>
          <path d="M10.6 5.6a3.2 3.2 0 0 1 0 4.8" />
          <path d="M12.4 3.9a5.6 5.6 0 0 1 0 8.2" />
        </>
      ) : (
        <path d="M10.8 6.2l3.4 3.6M14.2 6.2l-3.4 3.6" />
      )}
    </svg>
  );
}
