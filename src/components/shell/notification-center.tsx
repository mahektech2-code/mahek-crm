"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { answerNotifications, markNotificationRead, markNotificationsRead } from "@/lib/actions/crm";
import {
  ANNOUNCED_KEY,
  PREF_DESKTOP,
  PREF_SOUND,
  arrivals,
  nextPopups,
  popsUpIn,
  pruneAnnounced,
  soundOn,
  toneOf,
  type FeedAnswer,
  type FeedItem,
  type NotifyTone,
  type SnoozeCode,
} from "@/lib/notification-feed";
import { playChime, primeAudio } from "@/lib/notification-sound";
import { appFor } from "@/lib/app-routes";
import { shownIn, type AppUnread } from "@/lib/notification-apps";
import { NotificationModal } from "./notification-modal";

/* ---------------------------------------------------------------------------
 * THE LIVE BELL — one per tab, mounted in the root layout so every app gets
 * it: the CRM, Accounts, the Sales Dashboard, the Founder desk, all of them.
 *
 * It asks `/api/notifications` on a cadence, keeps the answer in a small store
 * the header bells read, and for whatever is NEW:
 *
 *   1. puts it in the pop-up over the screen (`notification-modal.tsx`) —
 *      "Notification 1 of 4" when several are waiting — where each one is
 *      answered: take action now, mark it done, or remind me in a while. A
 *      reminder needs no scheduled job: the time is stored on the row and this
 *      polling brings it back. It used to be a card in the corner that slid
 *      away after a few seconds, unanswered, everywhere but the ERP;
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

/** Answers a pop-up: done now, or back after the time picked. Keeps the badge honest at once. */
async function answerPopups(ids: string[], answer: "read" | "later", snooze?: SnoozeCode) {
  if (answer === "read") markLocal((n) => ids.includes(n.id));
  const res = await answerNotifications(ids, answer, snooze);
  refreshNotifications();
  return res;
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

/**
 * How long "Take action now" keeps the rest of the stack off the page it opened.
 * They come back when somebody leaves that page, or after this long on it — a
 * person who stays on one screen all afternoon must still be told things.
 */
const HOLD_ON_ACTION_MS = 10 * 60_000;

export function NotificationCenter() {
  const router = useRouter();
  const pathname = usePathname();
  /* The app this tab is showing. The list, the badge and what pops are that
     app's (and the general ones); a CRM decision does not pop over the ERP. */
  const viewApp = pathname ? appFor(pathname) : null;
  const appRef = React.useRef(viewApp);
  const [popups, setPopups] = React.useState<FeedItem[]>([]);
  /* After "Take action now": the page it opened, and until when the rest wait. */
  const [hold, setHold] = React.useState<{ path: string; until: number; arrived: boolean } | null>(null);
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
    const popsUp = popsUpIn(appRef.current);
    if (popsUp) {
      setPopups((current) => nextPopups(current, answer, fresh));
      /* Shown and not yet answered is due NOW on the server, so it comes back
         after a reload or on another machine until somebody answers it. */
      const unanswered = fresh.filter((n) => !n.remindAt).map((n) => n.id);
      if (unanswered.length) void answerNotifications(unanswered, "shown").catch(() => undefined);
    }
    /* A reminder chimes each time it comes back, so its claim names the reminder. */
    const toAnnounce = [
      ...fresh.map((n) => ({ n, key: n.id })),
      ...(popsUp ? (answer.due ?? []) : []).map((n) => ({ n, key: `${n.id}@${n.remindAt}` })),
    ];
    if (!toAnnounce.length) return;

    const hidden = document.visibilityState === "hidden";
    const sound = soundOn(readPref(PREF_SOUND));
    const desktop =
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      readPref(PREF_DESKTOP) !== "off";

    // One chime per batch, in the tone of the most serious thing in it.
    let chimeTone: NotifyTone | null = null;
    const rank: Record<NotifyTone, number> = { info: 0, success: 1, warn: 2, danger: 3 };
    for (const { n, key } of toAnnounce) {
      if (!claim(key)) continue;
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
      if (document.visibilityState === "visible") void poll();
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

  /* The hold ends when they leave the page "Take action now" opened, or when it times out. */
  const onHoldPage = hold !== null && (pathname === hold.path || Boolean(pathname?.startsWith(hold.path + "/")));
  if (hold && onHoldPage && !hold.arrived) setHold({ ...hold, arrived: true });
  else if (hold && !onHoldPage && hold.arrived) setHold(null);
  React.useEffect(() => {
    if (!hold) return;
    const t = setTimeout(() => setHold(null), Math.max(0, hold.until - Date.now()));
    return () => clearTimeout(t);
  }, [hold]);

  /* The factory app is a phone screen of its own, with its own toasts; a
     pop-up over a scan screen covers the one button that matters. */
  const onSignIn = pathname?.startsWith("/login") || pathname?.startsWith("/factory");
  /* A label or an invoice being printed is not to be stopped by a pop-up:
     the ERP's print-labels and print-invoices, and any page that is a print. */
  const onPrint = Boolean(pathname && (pathname.startsWith("/erp/print") || /\/print(\/|$)/.test(pathname)));
  const showPopups = !onSignIn && !onPrint && !hold && popsUpIn(viewApp) && popups.length > 0;
  const leave = (ids: string[]) => setPopups((q) => q.filter((n) => !ids.includes(n.id)));
  /* Taken off the screen at once; if the save fails it goes back, rather than being lost. */
  const answer = async (items: FeedItem[], how: "read" | "later", snooze?: SnoozeCode) => {
    const ids = items.map((n) => n.id);
    leave(ids);
    try {
      const res = await answerPopups(ids, how, snooze);
      if (!res.ok) setPopups((q) => [...items, ...q]);
    } catch {
      setPopups((q) => [...items, ...q]);
    }
  };
  if (!showPopups) return null;
  return (
    <NotificationModal
      queue={popups}
      onAct={(n) => {
        void answer([n], "read");
        /* The page they are sent to is the job: the rest stay in the stack, and
           wait until they leave it rather than landing on top of it. */
        if (n.href) {
          const path = n.href.split(/[?#]/)[0] || "/";
          if (popups.some((x) => x.id !== n.id)) setHold({ path, until: Date.now() + HOLD_ON_ACTION_MS, arrived: false });
          router.push(n.href);
        }
      }}
      onRead={(items) => void answer(items, "read")}
      onLater={(items, snooze) => void answer(items, "later", snooze)}
    />
  );
}

/* --------------------------------------------------------------------- icon */

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
