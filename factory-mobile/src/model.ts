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
import type { Draft, FactoryData, Proc, SubmitResult, Task, CheckItem, CheckStage, CountTask, StockSave } from "@/lib/factory/types";
import type { Me, Who } from "./types";
import type { DrumLotView, DrumSaved, LoadBoard, LrFields, LrRecent } from "@/lib/factory/types";

export type Net = "online" | "weak" | "offline";
export type Flow = { task: Task; step: number; d: Draft; key: string };
/** A box label the server judged: loaded onto the order, or looked up from the home scan. */
export type BoxOk = { ok: true; code: string; kind: "box"; name: string; text: string; facts: { l: string; v: string }[] };
export type Scan = { purpose: ScanPurpose; meta: ScanMeta; res: ((ScanResult | BoxOk) & { manual?: boolean }) | null; torch: boolean };
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
  /** Takes a decimal point — a weight in kg, where every other count is whole. */
  decimals?: boolean;
  set: (n: number) => void;
};
export type PeopleSheet = { type: "people"; role: "owner" | "op" | "helpers" | "ver"; multi: boolean; sel: string[]; area: string; onDone?: (sel: string[]) => void };
export type TilesSheet = { type: "tiles"; title: string; sub?: string; groups: { title?: string; cols?: number; items: { l: string; sub?: string; art?: ReactNode; v: string }[] }[]; pick: (v: string) => void };
export type ReasonSheet = { type: "reason"; title: string; sub?: string; reasons: string[]; okL?: string; sel?: string; danger?: boolean; done: (r: string) => void };
export type Sheet = KpSheet | PeopleSheet | TilesSheet | ReasonSheet | { type: "job"; id: string } | { type: "assign" } | { type: "dept" };

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
  /** The department the screen is showing, for somebody who works several; null is all of them. */
  dept: Proc | null;
  scan: Scan | null;
  flow: Flow | null;
  result: Res | null;
  sheet: Sheet | null;
  net: Net;
  toast: string;
  /** `warn` draws the toast as a caution — a refusal is never shown with a tick. */
  toastTone: "ok" | "warn";
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
  /** Empty drum entry: the lot scanned, the weight typed, and what the server answered. */
  drum: DrumEntry | null;
  /** Stock check: the office's counts, every item here, the one being counted, and what the server answered. */
  stock: StockEntry | null;
  /** The order being loaded: its boxes as the ERP holds them. */
  board: LoadBoard | null;
  /** Upload LR: the photo, what was read off it, and what the server answered. */
  lr: LrEntry | null;
};

export type LrEntry = {
  transporters: string[];
  terms: string[];
  canRead: boolean;
  recent: LrRecent[];
  /** The photo on this phone, and its attachment once uploaded. */
  photo: string | null;
  fileId: string | null;
  uploading: boolean;
  reading: boolean;
  readingId: string | null;
  /** Fields the photo reading filled — drawn "read" until somebody changes them. */
  read: Partial<Record<keyof LrFields, boolean>>;
  check: boolean;
  notes: string[];
  f: LrFields;
  err: { title: string; text: string; fix: string } | null;
  saving: boolean;
  saved: { id: string; msg: string; lrNo: string | null } | null;
  /** Many photos at once — the default, because the floor uploads a stack. */
  many: boolean;
  /** The photos waiting to go, each with its upload's progress. */
  tray: { uri: string; fileId: string | null; state: "waiting" | "uploading" | "up" | "failed" }[];
  batchBusy: boolean;
  batchMsg: string | null;
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

/** Empty drum entry on the phone. The server decides everything; this holds what it said. */
export type DrumEntry = {
  lot: DrumLotView;
  limits: { minKg: number; maxKg: number };
  kg: number | null;
  /** Minted when the drum is scanned; a resend of the same save answers with the first. */
  key: string;
  /** The server asked "is this a different drum of the same lot?". */
  ask: string | null;
  err: { title: string; text: string; fix: string } | null;
  saving: boolean;
  saved: DrumSaved | null;
};

export function mintDrumKey(): string {
  return "DRM-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/**
 * Stock check on the phone. Online only, on purpose: the book is read and
 * snapshotted the moment the server receives the figure, so a figure sent
 * hours later would be judged against a book that has since moved.
 */
export type StockEntry = {
  loading: boolean;
  err: { title: string; text: string; fix: string } | null;
  godown: string;
  office: CountTask[];
  items: CheckItem[];
  stage: CheckStage;
  search: string;
  /** What is being counted now. */
  pick: { kind: "count"; task: CountTask } | { kind: "check"; item: CheckItem } | null;
  qty: number | null;
  bin: string;
  /** Minted when an item is picked; a resend of the same save answers with the first. */
  key: string;
  saving: boolean;
  saved: Extract<StockSave, { ok: true }> | null;
  /** The optional reason after a mismatch. */
  reason: string;
  reasonSaving: boolean;
  reasonSaved: boolean;
};

export function mintCheckKey(): string {
  return "CHK-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
