/* ---------------------------------------------------------------------------
 * How the phone talks to the server: by op NAME, over the one URL every
 * MahekOne build answers (`/api/factory/rpc`) — the same door, the same
 * actions and the same ERP posting the web page uses. Nothing about a job is
 * decided on this phone that the server does not decide again.
 *
 * Two outcomes only. A value, or `NotReceived`: no network, a server that
 * did not answer, a 5xx. The second is never an error to show anybody — it
 * means "keep it and send again", and the caller does exactly that.
 *
 * THE SESSION is the id a browser would keep in a cookie. The server hands it
 * back on sign-in (`x-factory-session`), this file keeps it, and sends it on
 * every call; `proxy.ts` turns it back into the cookie.
 * ------------------------------------------------------------------------- */
import Constants from "expo-constants";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import { fitForUpload, photoBytes } from "./photo-fit";
import type { LorryBoard, LorryFind, LorryScan, QcInput, QcKit, QcSave, ReqInput, ReqKit, ReqSave } from "@/lib/factory/types";
import type { BoxInfo, BoxScan, CountInput, DrumLookup, StockCheckInput, StockKit, StockSave, DrumSave, FactoryData, LoadBoard, LrBatchSave, LrFields, LrKit, LrReading, LrSave, Proc, Submission, SubmitResult, Team } from "@/lib/factory/types";
import type { Me, Who } from "./types";
import { kvGet, kvSet } from "./model";

export const SITE: string = (process.env.EXPO_PUBLIC_SITE as string | undefined) || (Constants.expoConfig?.extra?.site as string | undefined) || "https://one.mahekindia.com";
/** What this phone is, so the server's audit can say which build sent a job. */
export const APP_BUILD = "native-" + (Constants.expoConfig?.version ?? "dev");

type Fail = { ok: false; error: string };
type SignedIn = { ok: true; me: Me; data: FactoryData; needPin: boolean };
type Done = { ok: true; data: FactoryData; msg: string } | Fail;

type Ops = {
  findPhone: (phone: string) => { ok: true; who: Who } | Fail;
  findBadge: (code: string) => { ok: true; who: Who } | Fail;
  signInPin: (userId: string, pin: string) => SignedIn | Fail;
  sendCode: (userId: string) => { ok: true; sentTo: string } | Fail;
  verifyCode: (userId: string, code: string) => SignedIn | Fail;
  setPin: (pin: string) => { ok: true } | Fail;
  setLang: (lang: string) => void;
  signOut: () => void;
  bootstrap: () => { ok: true; me: Me; data: FactoryData } | Fail;
  submit: (sub: Submission) => { result: SubmitResult; data: FactoryData | null };
  assign: (a: { proc: Proc; item: string; qty: number; due: string }) => Done;
  changeTeam: (taskId: string, role: keyof Team, sel: string[]) => Done;
  reportProblem: (taskId: string, reason: string, label: string) => Done;
  requestCorrection: (taskId: string, reason: string, label: string, rej?: number | null) => Done;
  decide: (id: string, act: string, actIndex: number, reason: string, helpers?: string[]) => Done;
  drumLookup: (code: string) => DrumLookup;
  emptyDrum: (input: { code: string; kg: number | null; key: string; different?: boolean }) => DrumSave;
  loadBoard: (order: string) => LoadBoard | null;
  scanBox: (order: string, code: string) => BoxScan;
  unloadBox: (order: string, unitId: string) => BoxScan;
  boxInfo: (code: string) => BoxInfo;
  lorryBoard: (key: string) => LorryBoard | null;
  lorryScan: (key: string, code: string, taskId: string | null, half: string | null) => LorryScan;
  lorryUnload: (key: string, unitId: string) => LorryScan;
  lorryOverride: (key: string, code: string, sku: string, reason: string) => { ok: true; message: string; board: LorryBoard } | { ok: false; error: string };
  lorryDecide: (key: string, id: string, approve: boolean, note: string | null) => { ok: true; message: string; board: LorryBoard } | { ok: false; error: string };
  lorryFind: (code: string) => LorryFind;
  lrKit: () => LrKit;
  readLr: (fileId: string) => LrReading;
  saveLr: (input: LrFields & { fileId: string | null; readingId: string | null; note?: string | null }) => LrSave;
  saveLrPhotos: (fileIds: string[]) => LrBatchSave;
  uploadTrouble: (reports: UploadTrouble[]) => { ok: true };
  stockKit: () => StockKit;
  stockCheck: (input: StockCheckInput) => StockSave;
  countSave: (input: CountInput) => StockSave;
  checkReason: (kind: "check" | "count", id: string, reason: string) => { ok: boolean };
  qcKit: () => QcKit;
  qcDecide: (input: QcInput) => QcSave;
  startBatch: (a: { item: string; qty: number }) => ({ ok: true; id: string; data: FactoryData; msg: string }) | Fail;
  startFill: (a: { lot: string; item: string; qty: number }) => ({ ok: true; id: string; data: FactoryData; msg: string }) | Fail;
  startPack: (a: { lot: string; item: string; qty: number }) => ({ ok: true; id: string; data: FactoryData; msg: string }) | Fail;
  reqKit: () => ReqKit;
  reqRaise: (input: ReqInput) => ReqSave;
  reqCancel: (id: string, reason: string) => { ok: true; msg: string } | { ok: false; error: string };
};

export class NotReceived extends Error {}

const SESSION_KEY = "session";
let session: string | null = kvGet(SESSION_KEY);

export function sessionHeaders(): Record<string, string> {
  return session ? { "x-factory-session": session } : {};
}

export async function call<K extends keyof Ops>(op: K, ...args: Parameters<Ops[K]>): Promise<ReturnType<Ops[K]>> {
  let r: Response;
  try {
    const ctl = new AbortController();
    /* A weak link that never answers must not hold a worker's screen: past
       this the send is treated as not received, and the queue keeps it. */
    const t = setTimeout(() => ctl.abort(), 25_000);
    r = await fetch(SITE + "/api/factory/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", "x-factory-client": APP_BUILD, ...sessionHeaders() },
      body: JSON.stringify({ op, args }),
      credentials: "omit",
      signal: ctl.signal,
    });
    clearTimeout(t);
  } catch {
    throw new NotReceived("network");
  }
  const next = r.headers.get("x-factory-session");
  if (next !== null) {
    session = next || null;
    kvSet(SESSION_KEY, session);
  }
  if (r.status >= 500 || r.status === 408 || r.status === 429) throw new NotReceived("server " + r.status);
  let j: { value?: unknown; error?: string };
  try {
    j = await r.json();
  } catch {
    throw new NotReceived("unreadable");
  }
  if (!r.ok) throw new NotReceived(j.error ?? "status " + r.status);
  return j.value as ReturnType<Ops[K]>;
}

/** Forget the session on this phone — a shared station phone's sign-out. */
export function dropSession() {
  session = null;
  kvSet(SESSION_KEY, null);
}

/** One upload that did not land, as the server log records it. */
export type UploadTrouble = { what: string; kind: "network" | "refused" | "app"; why: string; bytes: number | null; at: string; build: string };

/**
 * A file on the phone, as a FormData part `expo/fetch` can send.
 *
 * SDK 57 replaced the global `fetch` with `expo/fetch`, and that one cannot
 * send React Native's `{ uri, name, type }` file literal — it throws
 * "Unsupported FormDataPart implementation" while building the request, so
 * not one photo ever left a phone, nothing reached the server's log, and the
 * catch below it called that "No network". It accepts any part with a
 * `bytes()`, keeping `name` and `type` as the filename and content type —
 * the MBOS handset's own fix for the same upgrade (mbos-app/src/sync/api.ts).
 */
function filePart(uri: string, name: string, type: string): Blob {
  return {
    name,
    type,
    bytes: async () => new Uint8Array(await new File(uri).arrayBuffer()),
  } as unknown as Blob;
}

const TROUBLE_KEY = "uploadTrouble";

/**
 * EVERY UPLOAD THAT FAILS IS TOLD TO THE SERVER, so a photo that did not land
 * is a line in the log rather than nothing at all. Sent at once where it can
 * be; kept on the phone (the last 20) and sent with the next report where it
 * cannot — a report about having no network usually has none to go on.
 */
function reportTrouble(t: Omit<UploadTrouble, "at" | "build">) {
  let kept: UploadTrouble[] = [];
  try {
    kept = (JSON.parse(kvGet(TROUBLE_KEY) ?? "[]") as UploadTrouble[]).slice(-19);
  } catch {
    kept = [];
  }
  const all = [...kept, { ...t, at: new Date().toISOString(), build: APP_BUILD }];
  kvSet(TROUBLE_KEY, JSON.stringify(all));
  void call("uploadTrouble", all)
    .then(() => kvSet(TROUBLE_KEY, null))
    .catch(() => {});
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What became of one photo: its attachment id, or why not — in words a person can act on. */
export type PhotoSend = { ok: true; id: string } | { ok: false; kind: "network" | "refused" | "app"; why: string };

/**
 * A photo — the loaded truck, or an LR — made to fit and uploaded from the
 * file the camera wrote. Compressed first (`fitForUpload`), so size is never
 * the reason it fails. A dropped connection or a 5xx is tried once more after
 * a pause; a minute without an answer is a timeout, not a hang. Whatever
 * still fails is reported to the server and answered with its real reason.
 */
export async function sendPhoto(uri: string, name = "truck.jpg", what = "photo"): Promise<PhotoSend> {
  let fitted = uri;
  try {
    fitted = await fitForUpload(uri);
  } catch {
    /* The original goes: a photo is never held back for not shrinking. */
  }
  const bytes = photoBytes(fitted);
  let last: PhotoSend = { ok: false, kind: "network", why: "No answer from the server." };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await wait(2500);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    let r: Response;
    try {
      const body = new FormData();
      /* The browser preview hands over the bytes; a phone, the file itself. */
      if (Platform.OS === "web") body.append("file", await (await fetch(fitted)).blob(), name);
      else body.append("file", filePart(fitted, name, "image/jpeg"));
      r = await fetch(SITE + "/api/factory/photo", { method: "POST", body, headers: { "x-factory-client": APP_BUILD, ...sessionHeaders() }, credentials: "omit", signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      /* A request that could not even be BUILT is the app's fault, not the network's — said as such, never retried as if the Wi-Fi might come back. */
      if (!ctl.signal.aborted && /unsupported|formdata|not found|no such file|cannot read|could not read|ENOENT|permission/i.test(msg)) {
        reportTrouble({ what, kind: "app", why: msg.slice(0, 300), bytes });
        return { ok: false, kind: "app", why: msg };
      }
      last = { ok: false, kind: "network", why: ctl.signal.aborted ? "The upload took more than a minute." : msg || "No answer from the server." };
      continue;
    }
    clearTimeout(timer);
    if (r.status >= 500) {
      last = { ok: false, kind: "network", why: `The server answered ${r.status}.` };
      continue;
    }
    const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
    if (j.id) return { ok: true, id: j.id };
    const why = j.error ?? `The server answered ${r.status}.`;
    reportTrouble({ what, kind: "refused", why, bytes });
    return { ok: false, kind: "refused", why };
  }
  if (!last.ok) reportTrouble({ what, kind: last.kind, why: last.why, bytes });
  return last;
}

/**
 * The same, for a job that carries a photo: the attachment id, null when the
 * photo cannot be taken (a refusal is not a reason to lose the job — and it
 * has been reported), or throws NotReceived when nothing answered, so the job
 * waits on the phone with its photo.
 */
export async function uploadPhoto(uri: string, name = "truck.jpg"): Promise<string | null> {
  const r = await sendPhoto(uri, name, name === "lr.jpg" ? "LR photo" : "truck photo");
  if (r.ok) return r.id;
  if (r.kind === "network") throw new NotReceived("photo");
  return null;
}
