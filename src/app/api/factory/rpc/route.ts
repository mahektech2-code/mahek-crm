import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import * as A from "@/lib/actions/factory";

/* ---------------------------------------------------------------------------
 * THE FACTORY PHONE'S ONE DOOR, and it does not move between deploys.
 *
 * A server action's id is a hash minted at build time, so a page loaded
 * before a deploy calls ids the new server no longer has — and a station
 * phone keeps its page open for days, and keeps work queued for two of them.
 * Every call the phone makes comes here instead, by NAME. An op is added and
 * never renamed or removed: the newest server answers the oldest page.
 *
 * Each op is the same function the actions module exports, so the session,
 * the grant and every check stay exactly where they are.
 * ------------------------------------------------------------------------- */

const OPS = {
  findPhone: A.factoryFindPhone,
  findBadge: A.factoryFindBadge,
  signInPin: A.factorySignInPin,
  sendCode: A.factorySendCode,
  verifyCode: A.factoryVerifyCode,
  setPin: A.factorySetPin,
  setLang: A.factorySetLang,
  signOut: A.factorySignOut,
  bootstrap: A.factoryBootstrap,
  submit: A.factorySubmit,
  assign: A.factoryAssign,
  changeTeam: A.factoryChangeTeam,
  reportProblem: A.factoryReportProblem,
  requestCorrection: A.factoryRequestCorrection,
  decide: A.factoryDecide,
} as const;

export type FactoryOp = keyof typeof OPS;

const BUILD = process.env.FACTORY_BUILD ?? "dev";
const SESSION = "mahekone_session";

export async function POST(request: Request) {
  let body: { op?: string; args?: unknown[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "unreadable" }, { status: 400, headers: { "x-factory-build": BUILD } });
  }
  const fn = OPS[body.op as FactoryOp] as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (!fn) return NextResponse.json({ error: "unknown-op" }, { status: 404, headers: { "x-factory-build": BUILD } });
  try {
    const jar = await cookies();
    const before = jar.get(SESSION)?.value ?? "";
    const value = await fn(...(Array.isArray(body.args) ? body.args : []));
    const headers: Record<string, string> = { "x-factory-build": BUILD, "cache-control": "no-store" };
    /* The native app keeps its session itself (proxy.ts reads it back from
       `x-factory-session`), so a sign-in or sign-out says what it now is. A
       browser ignores this and keeps using its cookie. */
    const after = jar.get(SESSION)?.value ?? "";
    if (after !== before) headers["x-factory-session"] = after;
    return NextResponse.json({ value: value ?? null }, { headers });
  } catch (e) {
    /* A 5xx tells the phone "not received — keep it and try again", which is
       the one honest answer when the server itself failed. */
    console.error("[factory rpc]", body.op, e);
    return NextResponse.json({ error: "server" }, { status: 503, headers: { "x-factory-build": BUILD } });
  }
}
