import * as Crypto from 'expo-crypto';
import { getKv, setKv } from '../db';
import { postClientErrors } from '../sync/api';

/**
 * WHAT WENT WRONG ON THIS PHONE, kept until the office has it.
 *
 * MBOS recorded no error anywhere. A screen that crashed drew its message and
 * kept it on the phone; a fatal error outside a render, or one inside a
 * background task, left nothing at all. The only way the office ever heard was
 * a salesman photographing his screen — so most were never reported, and the
 * ones that were arrived with no build, no screen and no stack.
 *
 * So the error boundary and the global handler both write here, and the sync
 * sends the list up (`/api/mbos/errors`) and forgets what the server confirms.
 * The list is kept in `kv` rather than a table of its own because it is short
 * by construction — `KEEP` entries, newest kept — and a crash at boot may
 * arrive before a migration has run.
 *
 * Nothing here may throw. A crash logger that fails while logging a crash
 * replaces the error somebody needed to see with one about the logger.
 */

const KEY = 'mbos.clientErrors';
const KEEP = 20;

export type ClientError = {
  id: string;
  kind: 'render' | 'fatal' | 'error';
  message: string;
  stack: string | null;
  screen: string | null;
  at: number;
};

let screen: string | null = null;

/** The screen on top, so an error can say where it happened. */
export function noteCrashScreen(pathname: string | null): void {
  screen = pathname;
}

async function read(): Promise<ClientError[]> {
  try {
    const raw = await getKv(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as ClientError[]) : [];
  } catch {
    return [];
  }
}

async function write(list: ClientError[]): Promise<void> {
  try {
    await setKv(KEY, JSON.stringify(list.slice(-KEEP)));
  } catch {
    /* No storage, no record — and nothing else to be done about it. */
  }
}

/** Keep one error for the office. */
export async function recordError(kind: ClientError['kind'], error: unknown): Promise<void> {
  try {
    const e = error instanceof Error ? error : new Error(String(error));
    const entry: ClientError = {
      id: Crypto.randomUUID(),
      kind,
      message: (e.message || String(error)).slice(0, 2000),
      stack: e.stack ? e.stack.slice(0, 8000) : null,
      screen,
      at: Date.now(),
    };
    const list = await read();
    /* The same error thrown in a loop is one report, not twenty copies of it
       pushing every other entry off the end. */
    const last = list[list.length - 1];
    if (last && last.message === entry.message && last.screen === entry.screen && entry.at - last.at < 60_000) return;
    await write([...list, entry]);
  } catch {
    /* See the header: never throw from here. */
  }
}

let installed = false;

/**
 * Catch what no error boundary sees — a throw in an event handler, a timer or
 * a background task — and keep it, then let React Native do what it would have
 * done anyway. The previous handler is always called: in development it is the
 * red screen, and a release build's fatal path is not ours to replace.
 */
export function installCrashHandler(): void {
  if (installed) return;
  const utils = (globalThis as { ErrorUtils?: { getGlobalHandler(): (e: unknown, fatal?: boolean) => void; setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void } }).ErrorUtils;
  if (!utils) return;
  installed = true;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, fatal) => {
    void recordError(fatal ? 'fatal' : 'error', error);
    previous(error, fatal);
  });
}

/**
 * Send what is kept, and forget what the server confirms. Called at the end of
 * every sync; quiet on every failure, because the list simply waits for the
 * next one.
 */
export async function flushErrors(): Promise<void> {
  const list = await read();
  if (!list.length) return;
  try {
    const out = await postClientErrors(list);
    const received = new Set(out?.received ?? []);
    if (!received.size) return;
    /* Re-read: an error may have been kept while the request was out. */
    const now = await read();
    await write(now.filter((e) => !received.has(e.id)));
  } catch {
    /* No signal, signed out, an older server without the route. */
  }
}
