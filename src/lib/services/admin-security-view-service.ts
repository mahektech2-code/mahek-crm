import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import { OTP_REFUSAL_LABELS, deviceOf, labelOf } from "@/lib/otp-history";

/**
 * SECURITY & SIGN-INS, read for the console's one screen.
 *
 * Everything here is a count or a list over rows other parts of MahekOne
 * already write — sessions, `sign_in_failures`, `auth_otps`, the `sign-in`,
 * `sign-in-code` and `impersonate.enter` audit rows. Nothing is stored for the
 * screen. Where a fact is not recorded (a password sign-in's IP address, the
 * browser it came from) it is left out rather than guessed.
 */

type Row = Record<string, unknown>;
const rows = async <T extends Row>(q: ReturnType<typeof sql>): Promise<T[]> =>
  (await db.execute(q)) as unknown as T[];

const TODAY = sql`(now() at time zone ${APP_TIMEZONE})::date`;
const SINCE_TODAY = sql`(${TODAY})::timestamp at time zone ${APP_TIMEZONE}`;

export type SecurityFigures = {
  signedInNow: number;
  wrongPasswords24h: number;
  paused: number;
  codesSentToday: number;
  codesRefusedToday: number;
  impersonations7d: number;
  neverSignedIn: number;
};

export async function securityFigures(): Promise<SecurityFigures> {
  const config = await getConfig();
  const max = Number(config["auth.password.maxFailures"]);
  const windowMin = Number(config["auth.password.failureWindowMinutes"]);
  const [r] = await rows<{
    now: number;
    wrong: number;
    paused: number;
    sent: number;
    refused: number;
    imp: number;
    never: number;
  }>(sql`
    select
      (select count(distinct s.user_id)::int from sessions s where s.expires_at > now()) as now,
      (select count(*)::int from sign_in_failures f where f.at > now() - interval '24 hours') as wrong,
      (select count(*)::int from (
         select f.account from sign_in_failures f
          where f.at > now() - (${windowMin}::int * interval '1 minute')
          group by f.account having count(*) >= ${max}) p) as paused,
      (select count(*)::int from auth_otps o where o.created_at >= ${SINCE_TODAY} and o.refused_reason is null) as sent,
      (select count(*)::int from auth_otps o where o.created_at >= ${SINCE_TODAY} and o.refused_reason is not null) as refused,
      (select count(*)::int from audit_log a where a.action = 'impersonate.enter' and a.at > now() - interval '7 days') as imp,
      (select count(*)::int from users u where u.active and u.last_login_at is null
          and exists (select 1 from app_access x where x.user_id = u.id)) as never`);
  return {
    signedInNow: r.now,
    wrongPasswords24h: r.wrong,
    paused: r.paused,
    codesSentToday: r.sent,
    codesRefusedToday: r.refused,
    impersonations7d: r.imp,
    neverSignedIn: r.never,
  };
}

export type SignInEvent = {
  id: string;
  at: Date;
  /** The person, where one is known; a typed name otherwise. */
  userId: string | null;
  name: string;
  kind:
    | "signed_in"
    | "code_signin"
    | "wrong_password"
    | "paused"
    | "code_refused"
    | "impersonation";
  /** The plain words in the Result pill. */
  result: string;
  how: string;
  from: string | null;
  /** The account key a pause can be lifted on. */
  account: string | null;
};

/** One day's sign-in story, newest first: who came in, how, and who was turned away. */
export async function signInLog(
  opts: { day?: string | null; q?: string | null; limit?: number } = {},
): Promise<SignInEvent[]> {
  const config = await getConfig();
  const max = Number(config["auth.password.maxFailures"]);
  const day =
    opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day)
      ? sql`${opts.day}::date`
      : TODAY;
  const from = sql`(${day})::timestamp at time zone ${APP_TIMEZONE}`;
  const to = sql`((${day}) + 1)::timestamp at time zone ${APP_TIMEZONE}`;
  const limit = Math.min(opts.limit ?? 200, 500);

  const list = await rows<{
    id: string;
    at: Date;
    user_id: string | null;
    name: string | null;
    typed: string | null;
    kind: SignInEvent["kind"];
    detail: string | null;
    ip: string | null;
    ua: string | null;
    surface: string | null;
    account: string | null;
    nth: number | null;
  }>(sql`
    select * from (
      select a.id, a.at, a.actor_id as user_id, u.name, null::text as typed,
             case a.action when 'sign-in-code' then 'code_signin' when 'impersonate.enter' then 'impersonation' else 'signed_in' end as kind,
             case when a.action = 'impersonate.enter' then (select t.name from users t where t.id = a.entity_id) end as detail,
             null::text as ip, null::text as ua, null::text as surface, null::text as account, null::int as nth
        from audit_log a left join users u on u.id = a.actor_id
       where a.action in ('sign-in', 'sign-in-code', 'impersonate.enter') and a.at >= ${from} and a.at < ${to}
      union all
      select f.id, f.at,
             case when f.account like 'user:%' then substr(f.account, 6) end,
             u.name,
             case when f.account like 'name:%' then substr(f.account, 6) end,
             case when count(*) over (partition by f.account order by f.at
                     range between (${Number(config["auth.password.failureWindowMinutes"])}::int * interval '1 minute') preceding and current row) >= ${max}
                  then 'paused' else 'wrong_password' end,
             null, f.address, null, null, f.account,
             (count(*) over (partition by f.account order by f.at range between interval '24 hours' preceding and current row))::int
        from sign_in_failures f left join users u on f.account = 'user:' || u.id
       where f.at >= ${from} and f.at < ${to}
      union all
      select o.id, o.created_at, o.user_id, u.name, o.requested_with, 'code_refused', o.refused_reason,
             o.request_ip, o.user_agent, o.surface, null, null
        from auth_otps o left join users u on u.id = o.user_id
       where o.refused_reason is not null and o.created_at >= ${from} and o.created_at < ${to}
    ) x
    order by x.at desc
    limit ${limit}`);

  const needle = opts.q?.trim().toLowerCase() || null;
  return list
    .map((r): SignInEvent => {
      const name = r.name ?? r.typed ?? "Unknown";
      const device = r.ua ? deviceOf(r.ua) : null;
      const where =
        [maskIp(r.ip), device && device !== "Not recorded" ? device : null]
          .filter(Boolean)
          .join(" · ") || null;
      switch (r.kind) {
        case "impersonation":
          return {
            id: r.id,
            at: new Date(r.at),
            userId: r.user_id,
            name,
            kind: r.kind,
            result: `Signed in as ${firstName(r.detail ?? "somebody")}`,
            how: "Impersonation",
            from: null,
            account: null,
          };
        case "code_signin":
          return {
            id: r.id,
            at: new Date(r.at),
            userId: r.user_id,
            name,
            kind: r.kind,
            result: "Signed in",
            how: "WhatsApp code",
            from: null,
            account: null,
          };
        case "wrong_password":
        case "paused":
          return {
            id: r.id,
            at: new Date(r.at),
            userId: r.user_id,
            name,
            kind: r.kind,
            result: r.kind === "paused" ? "Paused" : "Wrong password",
            how:
              r.nth && r.nth > 1
                ? `Password · ${ordinal(r.nth)} wrong`
                : "Password",
            from: where,
            account: r.account,
          };
        case "code_refused":
          return {
            id: r.id,
            at: new Date(r.at),
            userId: r.user_id,
            name,
            kind: r.kind,
            result: "Code refused",
            how: labelOf(OTP_REFUSAL_LABELS, r.detail),
            from: where,
            account: null,
          };
        default:
          return {
            id: r.id,
            at: new Date(r.at),
            userId: r.user_id,
            name,
            kind: "signed_in",
            result: "Signed in",
            how: "Password",
            from: null,
            account: null,
          };
      }
    })
    .filter(
      (e) =>
        !needle ||
        e.name.toLowerCase().includes(needle) ||
        (e.from ?? "").toLowerCase().includes(needle),
    );
}

export type PausedAccount = {
  account: string;
  userId: string | null;
  name: string;
  failures: number;
  lastAt: Date;
  addresses: string[];
};

/** Accounts shut right now by wrong passwords, each with what shut it. */
export async function pausedAccounts(): Promise<PausedAccount[]> {
  const config = await getConfig();
  const max = Number(config["auth.password.maxFailures"]);
  const windowMin = Number(config["auth.password.failureWindowMinutes"]);
  const list = await rows<{
    account: string;
    name: string | null;
    failures: number;
    last_at: Date;
    addresses: string[] | null;
  }>(sql`
    select f.account, u.name, count(*)::int as failures, max(f.at) as last_at,
           array_remove(array_agg(distinct f.address), null) as addresses
      from sign_in_failures f left join users u on f.account = 'user:' || u.id
     where f.at > now() - (${windowMin}::int * interval '1 minute')
     group by f.account, u.name
    having count(*) >= ${max}
     order by max(f.at) desc`);
  return list.map((r) => ({
    account: r.account,
    userId: r.account.startsWith("user:") ? r.account.slice(5) : null,
    name: r.name ?? r.account.replace(/^name:/, ""),
    failures: r.failures,
    lastAt: new Date(r.last_at),
    addresses: (r.addresses ?? []).map((a) => maskIp(a) ?? a),
  }));
}

/** "49.36.112.8" → "49.36.x.x": enough to tell two offices apart, not to locate a person. */
function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  const parts = ip.split(":").filter(Boolean);
  return parts.length > 2 ? `${parts.slice(0, 2).join(":")}:…` : ip;
}

const firstName = (n: string) => n.split(/\s+/)[0];
const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
