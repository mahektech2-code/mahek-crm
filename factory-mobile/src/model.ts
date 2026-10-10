/* ---------------------------------------------------------------------------
 * The phone's own state: what is on screen, what is half-done, and what is
 * waiting to send — the web app's model (src/app/factory/_ui/model.ts) with
 * the phone's storage underneath it.
 *
 * Data lives in SQLite (expo-sqlite's key-value store, read synchronously so
 * the app opens on the floor it last saw, with no network); photos taken
 * offline live as files in the app's documents, where the system never
 * clears them. Both survive the app being closed, the phone restarting, and
 * a new version of the app being installed over this one.
 * ------------------------------------------------------------------------- */
import type StorageT from "expo-sqlite/kv-store";
import * as FS from "expo-file-system/legacy";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Platform } from "react-native";
import type { ReactNode } from "react";
import type { Lang } from "@/lib/factory/i18n";
import type { ScanMeta, ScanPurpose, ScanResult } from "@/lib/factory/rules";
import type { Draft, FactoryData, Proc, SubmitResult, Task } from "@/lib/factory/types";
import type { Me, Who } from "./types";

export type Net = "online" | "weak" | "offline";
export type Flow = { task: Task; step: number; d: Draft; key: string };
export type Scan = { purpose: ScanPurpose; meta: ScanMeta; res: (ScanResult & { manual?: boolean }) | null; torch: boolean };
export type Res =
  | { kind: "sending"; key: string }
  | { kind: "pending"; key: string; task: string; proc: Proc }
  | SubmitResult;
/**
 * One job waiting on this phone. `savedIso` is when it was finished — what the
 * ERP document is dated and what the 48-hour window is measured from.
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
export type TilesSheet = { type: "tiles"; title: string; sub?: string; groups: { title?: string; cols?: number; items: { l: string; sub?: string; art?: ReactNode; v: string }[] }[]; pick: (v: string) => void };
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
};

/* ------------------------------------------------------------ the phone's memory */

const K = (me: string | null, k: string) => "mahek.factory." + (me ? me + "." : "") + k;

/* A browser preview (react-native-web, for testing) keeps the same keys in localStorage. */
const WEB = Platform.OS === "web";
/* Required, not imported: on the web preview SQLite would load a WASM worker for nothing. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Storage: typeof StorageT = WEB ? (null as unknown as typeof StorageT) : require("expo-sqlite/kv-store").default;

export function kvGet(k: string): string | null {
  try {
    return WEB ? window.localStorage.getItem(k) : Storage.getItemSync(k);
  } catch {
    return null;
  }
}
export function kvSet(k: string, v: string | null) {
  try {
    if (WEB) {
      if (v == null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, v);
    } else if (v == null) Storage.removeItemSync(k);
    else Storage.setItemSync(k, v);
  } catch {
    /* A full disk: the work is still in memory. */
  }
}

export function load<T>(me: string | null, k: string, fallback: T): T {
  const v = kvGet(K(me, k));
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function save(me: string | null, k: string, v: unknown) {
  kvSet(K(me, k), v == null ? null : JSON.stringify(v));
}

/** The idempotency key: minted once when a job starts, unique across every phone. */
export function mintKey(taskId: string): string {
  const r = Math.random().toString(36).slice(2, 7);
  return "MOB-" + taskId.replace(/^T-/, "") + "-" + Date.now().toString(36) + r;
}

/* ------------------------------------------------------------ the network */

let lastNet: Net = "online";
function netOf(s: NetInfoState): Net {
  if (s.isConnected === false || s.isInternetReachable === false) return "offline";
  const gen = (s.details as { cellularGeneration?: string } | null)?.cellularGeneration;
  if (s.type === "cellular" && gen === "2g") return "weak";
  return "online";
}
/** What the network looks like from here, without asking the server. */
export function readNet(): Net {
  return lastNet;
}
export function watchNet(fn: (n: Net) => void): () => void {
  return NetInfo.addEventListener((s) => {
    lastNet = netOf(s);
    fn(lastNet);
  });
}

/* ------------------------------------------------------------ photos kept offline */

/*
 * A truck photographed with no network is kept on the phone, as a file in the
 * app's documents, and uploaded just before its job is sent. The job is never
 * refused for want of a signal at the moment the shutter was pressed.
 */
const DIR = (FS.documentDirectory ?? "") + "factory-photos/";
const photoPath = (key: string) => DIR + key.replace(/[^\w-]/g, "_") + ".jpg";

export async function keepPhoto(key: string, uri: string): Promise<boolean> {
  try {
    await FS.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    await FS.deleteAsync(photoPath(key), { idempotent: true });
    await FS.copyAsync({ from: uri, to: photoPath(key) });
    return true;
  } catch {
    return false;
  }
}

export async function keptPhoto(key: string): Promise<string | null> {
  try {
    const i = await FS.getInfoAsync(photoPath(key));
    return i.exists ? photoPath(key) : null;
  } catch {
    return null;
  }
}

export async function dropPhoto(key: string): Promise<void> {
  try {
    await FS.deleteAsync(photoPath(key), { idempotent: true });
  } catch {}
}

/** Everything this phone remembers about a person, for a shared phone's sign-out. Their queue stays. */
export function forget(me: string) {
  try {
    const pre = "mahek.factory." + me + ".";
    const keys = WEB ? Object.keys(window.localStorage) : Storage.getAllKeysSync();
    for (const k of keys) if (k.startsWith(pre) && !k.endsWith(".queue")) kvSet(k, null);
    kvSet("mahek.factory.me", null);
  } catch {}
}
