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
import { Platform } from "react-native";
import type { FactoryData, Proc, Submission, SubmitResult, Team } from "@/lib/factory/types";
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

/**
 * The truck photo, uploaded from the file the camera wrote. Returns the
 * attachment id, null when the server refused the file (a refusal is not a
 * reason to lose the job), or throws NotReceived when nothing answered.
 */
export async function uploadPhoto(uri: string): Promise<string | null> {
  const body = new FormData();
  /* A phone hands FormData the file by its path; the browser preview needs the bytes. */
  if (Platform.OS === "web") body.append("file", await (await fetch(uri)).blob(), "truck.jpg");
  else body.append("file", { uri, name: "truck.jpg", type: "image/jpeg" } as unknown as Blob);
  let r: Response;
  try {
    r = await fetch(SITE + "/api/factory/photo", { method: "POST", body, headers: sessionHeaders(), credentials: "omit" });
  } catch {
    throw new NotReceived("photo");
  }
  if (r.status >= 500) throw new NotReceived("photo");
  const j = (await r.json().catch(() => ({}))) as { id?: string };
  return j.id ?? null;
}
