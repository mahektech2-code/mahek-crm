/* ---------------------------------------------------------------------------
 * How the phone talks to the server: by op NAME, over one URL that every
 * build answers (`/api/factory/rpc`). Never a server action — their ids
 * change on every deploy, and a station phone keeps its page for days.
 *
 * Two outcomes only. A value, or `NotReceived`: no network, a server that
 * did not answer, a 5xx. The second is never an error to show anybody — it
 * means "keep it and send again", and the caller does exactly that.
 * ------------------------------------------------------------------------- */
import type * as Actions from "@/lib/actions/factory";

type Ops = {
  findPhone: typeof Actions.factoryFindPhone;
  findBadge: typeof Actions.factoryFindBadge;
  signInPin: typeof Actions.factorySignInPin;
  sendCode: typeof Actions.factorySendCode;
  verifyCode: typeof Actions.factoryVerifyCode;
  setPin: typeof Actions.factorySetPin;
  setLang: typeof Actions.factorySetLang;
  signOut: typeof Actions.factorySignOut;
  bootstrap: typeof Actions.factoryBootstrap;
  submit: typeof Actions.factorySubmit;
  assign: typeof Actions.factoryAssign;
  changeTeam: typeof Actions.factoryChangeTeam;
  reportProblem: typeof Actions.factoryReportProblem;
  requestCorrection: typeof Actions.factoryRequestCorrection;
  decide: typeof Actions.factoryDecide;
};

export class NotReceived extends Error {}

/** The build this page was made from — compared with the one the server answers in. */
export const PAGE_BUILD = process.env.FACTORY_BUILD ?? "dev";

let onBuild: ((b: string) => void) | null = null;
/** Told when the server is a newer build than this page. */
export function watchBuild(fn: (b: string) => void) {
  onBuild = fn;
}

export async function call<K extends keyof Ops>(op: K, ...args: Parameters<Ops[K]>): Promise<Awaited<ReturnType<Ops[K]>>> {
  let r: Response;
  try {
    const ctl = new AbortController();
    /* A weak link that never answers must not hold a worker's screen: past
       this the send is treated as not received, and the queue keeps it. */
    const t = setTimeout(() => ctl.abort(), 25_000);
    r = await fetch("/api/factory/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, args }),
      cache: "no-store",
      credentials: "same-origin",
      signal: ctl.signal,
    });
    clearTimeout(t);
  } catch {
    throw new NotReceived("network");
  }
  const build = r.headers.get("x-factory-build");
  if (build && build !== PAGE_BUILD && onBuild) onBuild(build);
  if (r.status >= 500 || r.status === 408 || r.status === 429) throw new NotReceived("server " + r.status);
  let j: { value?: unknown; error?: string };
  try {
    j = await r.json();
  } catch {
    throw new NotReceived("unreadable");
  }
  if (!r.ok) throw new NotReceived(j.error ?? "status " + r.status);
  return j.value as Awaited<ReturnType<Ops[K]>>;
}
