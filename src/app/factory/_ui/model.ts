/* ---------------------------------------------------------------------------
 * The phone's own state: what is on screen, what is half-done, and what is
 * waiting to send. PURE and client-safe.
 * ------------------------------------------------------------------------- */
import type { Lang } from "@/lib/factory/i18n";
import type { ScanMeta, ScanPurpose, ScanResult } from "@/lib/factory/rules";
import type { Draft, FactoryData, Proc, SubmitResult, Task } from "@/lib/factory/types";
import type { Me, Who } from "@/lib/actions/factory";

export type Net = "online" | "weak" | "offline";
export type Flow = { task: Task; step: number; d: Draft; key: string };
export type Scan = { purpose: ScanPurpose; meta: ScanMeta; res: (ScanResult & { manual?: boolean }) | null; torch: boolean };
export type Res =
  | { kind: "sending"; key: string }
  | { kind: "pending"; key: string; task: string; proc: Proc }
  | SubmitResult;
/**
 * One job waiting on this phone. `savedIso` is when it was finished — what the
 * ERP document is dated and what the 48-hour window is measured from. Items
 * written by an older page have only `at` ("HH:MM"), and still send.
 */
export type QItem = {
  key: string;
  flow: Flow;
  at: string;
  savedIso?: string;
  status: "pending" | "done" | "failed" | "held";
  doneAt?: string;
  result?: SubmitResult;
};

export type KpSheet = {
  type: "kp";
  l: string;
  unit: string;
  v: string;
  max?: number | null;
  maxL?: string;
  quick?: { l: string; v: number }[];
  allowZero?: boolean;
  set: (n: number) => void;
};
export type PeopleSheet = { type: "people"; role: "owner" | "op" | "helpers" | "ver"; multi: boolean; sel: string[]; area: string; onDone?: (sel: string[]) => void };
export type TilesSheet = { type: "tiles"; title: string; sub?: string; groups: { title?: string; cols?: number; items: { l: string; sub?: string; art?: React.ReactNode; v: string }[] }[]; pick: (v: string) => void };
export type ReasonSheet = { type: "reason"; title: string; sub?: string; reasons: string[]; okL?: string; sel?: string; danger?: boolean; done: (r: string) => void };
export type Sheet = KpSheet | PeopleSheet | TilesSheet | ReasonSheet | { type: "menu" } | { type: "job"; id: string } | { type: "assign" };

export type SignStep = "lang" | "id" | "pin" | "otp" | "newpin";

export type State = {
  lang: Lang;
  me: Me | null;
  db: FactoryData | null;
  signStep: SignStep;
  phone: string;
  idErr: string;
  otp: string;
  otpErr: string;
  otpT: number;
  otpTo: string;
  pinFor: Who | null;
  pin: string;
  pinErr: string;
  newPin: string;
  newPin1: string;
  route: string;
  scan: Scan | null;
  flow: Flow | null;
  result: Res | null;
  sheet: Sheet | null;
  net: Net;
  toast: string;
  play: { id: string; t: number; dur: number; on: boolean } | null;
  hf: string;
  asg: { proc: Proc; item: string; qty: number; due: string } | null;
  started: Record<string, 1>;
  drafts: Record<string, Flow>;
  results: Record<string, SubmitResult>;
  queue: QItem[];
  sending: boolean;
  busy: boolean;
  clock: string;
  cam: "wait" | "live" | "none" | "denied";
  /** A newer build is live; the page reloads itself once nothing is in hand. */
  newBuild: boolean;
};

/* ------------------------------------------------------------ the phone's memory */

const K = (me: string | null, k: string) => "mahek.factory." + (me ? me + "." : "") + k;

export function load<T>(me: string | null, k: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(K(me, k));
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(me: string | null, k: string, v: unknown) {
  try {
    if (v == null) window.localStorage.removeItem(K(me, k));
    else window.localStorage.setItem(K(me, k), JSON.stringify(v));
  } catch {
    /* Private mode or a full disk: the work is still in memory. */
  }
}

/** The idempotency key: minted once when a job starts, unique across every phone. */
export function mintKey(taskId: string): string {
  const r = Math.random().toString(36).slice(2, 7);
  return "MOB-" + taskId.replace(/^T-/, "") + "-" + Date.now().toString(36) + r;
}

/** What the network looks like from here, without asking the server. */
export function readNet(): Net {
  if (typeof navigator === "undefined") return "online";
  if (!navigator.onLine) return "offline";
  const c = (navigator as unknown as { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
  if (c && (c.effectiveType === "slow-2g" || c.effectiveType === "2g")) return "weak";
  return "online";
}

/* ------------------------------------------------------------ photos kept offline */

/*
 * A truck photographed with no network is kept on the phone, in IndexedDB —
 * localStorage holds a few megabytes and a day of photos would fill it — and
 * uploaded just before its job is sent. The job is never refused for want of
 * a signal at the moment the shutter was pressed.
 */
const DB = "mahek-factory";
const STORE = "photos";

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function keepPhoto(key: string, blob: Blob): Promise<boolean> {
  try {
    const d = await idb();
    await new Promise<void>((res, rej) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function keptPhoto(key: string): Promise<Blob | null> {
  try {
    const d = await idb();
    return await new Promise<Blob | null>((res) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res((r.result as Blob) ?? null);
      r.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

export async function dropPhoto(key: string): Promise<void> {
  try {
    const d = await idb();
    d.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
  } catch {}
}

/** Everything this phone remembers about a person, for a shared phone's sign-out. */
export function forget(me: string) {
  try {
    const pre = "mahek.factory." + me + ".";
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(pre) && !k.endsWith(".queue")) window.localStorage.removeItem(k);
    }
    window.localStorage.removeItem("mahek.factory.me");
  } catch {}
}
