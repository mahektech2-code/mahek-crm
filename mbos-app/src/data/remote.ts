import { useEffect, useSyncExternalStore } from 'react';
import { getKv, setKv } from '../db';

/**
 * WHAT THE OFFICE CAN CHANGE ON THIS PHONE WITHOUT A RELEASE — switches,
 * sentences and banners, set in Admin Console → MBOS control and resolved for
 * this person on the server (`src/lib/engines/mbos-remote.ts`).
 *
 * EVERYTHING HERE HAS A COMPILED FALLBACK, and absence is always the answer
 * that keeps the app as it was built: a switch nobody set is the default the
 * caller passed, a sentence nobody set is the one in the screen's own code, no
 * banner is no card. A phone that has never pulled, a server too old to send
 * the field, a pass where the server could not read it — all of them draw
 * exactly the shipped app.
 *
 * NOTHING ON THE TRAIL'S PATH READS THIS, AND THIS READS NOTHING ON IT. The
 * fixes every few seconds, their cadence, the watchdog and the upload run on
 * `mbos.location.*` from the ordinary configuration and the native service;
 * `src/lib/engines/mbos-remote.test.ts` fails the build if either side
 * imports the other, and the server refuses any key that names location.
 */

export type RemoteBanner = {
  id: string;
  screen: 'home' | 'more';
  title: string;
  body?: string;
  imageUrl?: string;
  tone?: 'info' | 'success' | 'warn';
  route?: string;
  url?: string;
  order?: number;
  startsAt?: string;
  endsAt?: string;
};

export type RemoteState = {
  version: string;
  flags: Record<string, boolean>;
  texts: Record<string, string>;
  banners: RemoteBanner[];
};

/** The same list the server refuses to hide — a stale or wrong row still cannot. */
export const PROTECTED_ROUTES = [
  'home',
  'attendance',
  'travel',
  'tracking-setup',
  'phone-setup',
  'setup',
  'sync',
  'maps',
  'visit',
  'profile',
];

const KV_KEY = 'remote.v1';
const EMPTY: RemoteState = { version: '', flags: {}, texts: {}, banners: [] };

let state: RemoteState = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: RemoteState): void {
  state = next;
  for (const l of listeners) l();
}

/** Only the shape this build can draw — a field it does not know is dropped. */
function sanitise(raw: unknown): RemoteState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RemoteState>;
  const flags: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(r.flags ?? {})) if (typeof v === 'boolean') flags[k] = v;
  const texts: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.texts ?? {})) if (typeof v === 'string' && v.trim()) texts[k] = v;
  const banners = (Array.isArray(r.banners) ? r.banners : []).filter(
    (b): b is RemoteBanner =>
      !!b && typeof b === 'object' && typeof b.id === 'string' && typeof b.title === 'string' && (b.screen === 'home' || b.screen === 'more'),
  );
  return { version: typeof r.version === 'string' ? r.version : '', flags, texts, banners };
}

/**
 * The pull's `remote` channel. Undefined — a server that predates it — and
 * null — a pass where the server could not read it — both leave what this
 * phone already holds, so a hiccup never takes a banner down or a switch back.
 */
export async function storeRemote(raw: unknown): Promise<number> {
  if (raw == null) return 0;
  const next = sanitise(raw);
  if (!next) return 0;
  await setKv(KV_KEY, JSON.stringify(next));
  loaded = true;
  if (next.version !== state.version || state === EMPTY) publish(next);
  return 1;
}

/** Read once from SQLite into memory. Safe to call any number of times. */
export async function loadRemote(): Promise<RemoteState> {
  if (loaded) return state;
  try {
    const raw = await getKv(KV_KEY);
    const parsed = raw ? sanitise(JSON.parse(raw)) : null;
    loaded = true;
    if (parsed) publish(parsed);
  } catch {
    /* A corrupt row is the shipped app, not a crash. */
    loaded = true;
  }
  return state;
}

/* Reads take the state from `useRemote()`, so a screen re-renders when a pull
   changes what it shows rather than reading a module variable it never
   subscribed to. */

export function isOn(s: RemoteState, key: string, fallback: boolean): boolean {
  const v = s.flags[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function copy(s: RemoteState, key: string, fallback: string): string {
  return s.texts[key] ?? fallback;
}

export function menuHidden(s: RemoteState, route: string): boolean {
  if (PROTECTED_ROUTES.includes(route)) return false;
  return s.flags[`menu.${route}.hidden`] === true;
}

export function bannersFor(s: RemoteState, screen: RemoteBanner['screen'], nowMs: number): RemoteBanner[] {
  /* One switch takes every banner off every phone at once. */
  if (!isOn(s, 'feature.banners', true)) return [];
  /* The server checks the window when it sends; this checks it again because
     a phone may go a day without a pull and a Diwali offer must still end. */
  return s.banners.filter(
    (b) =>
      b.screen === screen &&
      !(b.startsAt && Date.parse(b.startsAt) > nowMs) &&
      !(b.endsAt && Date.parse(b.endsAt) < nowMs),
  );
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The live state; re-renders when a pull brings something new. */
export function useRemote(): RemoteState {
  useEffect(() => {
    void loadRemote();
  }, []);
  return useSyncExternalStore(subscribe, () => state, () => state);
}
