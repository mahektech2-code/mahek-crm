import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE } from "@/lib/business-date";
import { OTP_STATUSES, type OtpStatus } from "@/lib/otp-history";

/* ---------------------------------------------------------------------------
 * EVERY ONE-TIME CODE MAHEKONE HAS SENT, OR WAS ASKED FOR AND DID NOT.
 *
 * Read by the Admin Console's OTP history, which is a platform
 * administrator's screen: it names people and their personal mobiles, so the
 * page asks `requirePlatformAdmin` before calling anything here.
 *
 * Filtered, counted and paged in the database. `OTP_STATUS_SQL` is
 * `otpStatus` in lib/otp-history.ts spelled as a CASE, so a filter on a status
 * returns exactly the rows the screen would label with it.
 * ------------------------------------------------------------------------- */

const statusSql = (maxAttempts: number) => sql`(case
  when o.refused_reason is not null then 'refused'
  when o.sent_at is null then 'send_failed'
  when o.consumed_at is not null then 'verified'
  when o.attempts >= ${maxAttempts}::int then 'locked'
  when o.expires_at < now() then 'expired'
  else 'waiting' end)`;

export type OtpHistoryFilters = {
  q?: string;
  purpose?: string;
  status?: string;
  provider?: string;
  surface?: string;
  userId?: string;
  /** Calendar dates, inclusive, in the business zone. */
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
};

export type OtpHistoryRow = {
  id: string;
  createdAt: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  userPhone: string | null;
  userActive: boolean | null;
  employeeName: string | null;
  employeeCode: string | null;
  purpose: string;
  surface: string | null;
  requestedWith: string | null;
  destination: string;
  provider: string | null;
  providerRef: string | null;
  providerResponse: unknown;
  sentAt: string | null;
  expiresAt: string;
  consumedAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastAttemptResult: string | null;
  failureReason: string | null;
  refusedReason: string | null;
  requestIp: string | null;
  userAgent: string | null;
  status: OtpStatus;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function whereOf(f: OtpHistoryFilters, maxAttempts: number): SQL {
  const parts: SQL[] = [sql`true`];
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    const digits = q.replace(/\D/g, "");
    parts.push(sql`(
      lower(coalesce(u.name, '')) like ${like}
      or lower(coalesce(u.email, '')) like ${like}
      or lower(coalesce(e.name, '')) like ${like}
      or lower(coalesce(e.employee_code, '')) like ${like}
      or lower(coalesce(o.requested_with, '')) like ${like}
      or lower(coalesce(o.provider_ref, '')) like ${like}
      or coalesce(o.request_ip, '') like ${like}
      ${digits.length >= 3 ? sql`or regexp_replace(o.destination, '\\D', '', 'g') like ${`%${digits}%`}
      or regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') like ${`%${digits}%`}` : sql``}
    )`);
  }
  if (f.purpose) parts.push(sql`o.purpose = ${f.purpose}`);
  if (f.provider) parts.push(sql`o.provider = ${f.provider}`);
  if (f.surface) parts.push(sql`o.surface = ${f.surface}`);
  if (f.userId) parts.push(sql`o.user_id = ${f.userId}`);
  if (f.status && (OTP_STATUSES as readonly string[]).includes(f.status)) {
    parts.push(sql`${statusSql(maxAttempts)} = ${f.status}`);
  }
  // A day is the business day, so "today" means today in Kolkata whatever the
  // database session's zone happens to be.
  if (f.from && DATE.test(f.from)) {
    parts.push(sql`o.created_at >= (${f.from}::date)::timestamp at time zone ${APP_TIMEZONE}`);
  }
  if (f.to && DATE.test(f.to)) {
    parts.push(sql`o.created_at < (${f.to}::date + 1)::timestamp at time zone ${APP_TIMEZONE}`);
  }
  return sql.join(parts, sql` and `);
}

const FROM = sql`from auth_otps o
  left join users u on u.id = o.user_id
  left join employees e on e.id = u.employee_id`;

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

export async function otpHistory(filters: OtpHistoryFilters) {
  const config = await getConfig();
  const maxAttempts = Number(config["auth.otp.maxVerifyAttempts"]);
  const perPage = [25, 50, 100].includes(Number(filters.perPage)) ? Number(filters.perPage) : 50;
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const where = whereOf(filters, maxAttempts);

  const [rows, totals] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select o.*, u.name as user_name, u.email as user_email, u.phone as user_phone, u.active as user_active,
             e.name as employee_name, e.employee_code as employee_code,
             ${statusSql(maxAttempts)} as status
      ${FROM}
      where ${where}
      order by o.created_at desc, o.id desc
      limit ${perPage} offset ${(page - 1) * perPage}
    `),
    db.execute<Record<string, unknown>>(sql`
      select count(*)::int as total,
             count(*) filter (where o.refused_reason is null)::int as requested,
             count(*) filter (where o.sent_at is not null)::int as sent,
             count(*) filter (where o.consumed_at is not null)::int as verified,
             count(*) filter (where o.refused_reason is null and o.sent_at is null)::int as send_failed,
             count(*) filter (where o.refused_reason is not null)::int as refused,
             count(*) filter (where ${statusSql(maxAttempts)} = 'locked')::int as locked,
             count(*) filter (where ${statusSql(maxAttempts)} = 'expired')::int as expired,
             coalesce(sum(o.attempts), 0)::int as wrong_tries,
             count(distinct o.user_id)::int as people,
             count(distinct o.destination) filter (where o.destination <> '')::int as numbers
      ${FROM}
      where ${where}
    `),
  ]);

  const t = totals[0] ?? {};
  const total = Number(t.total ?? 0);
  return {
    maxAttempts,
    page,
    perPage,
    total,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
    summary: {
      total,
      requested: Number(t.requested ?? 0),
      sent: Number(t.sent ?? 0),
      verified: Number(t.verified ?? 0),
      sendFailed: Number(t.send_failed ?? 0),
      refused: Number(t.refused ?? 0),
      locked: Number(t.locked ?? 0),
      expired: Number(t.expired ?? 0),
      wrongTries: Number(t.wrong_tries ?? 0),
      people: Number(t.people ?? 0),
      numbers: Number(t.numbers ?? 0),
    },
    rows: rows.map(
      (r): OtpHistoryRow => ({
        id: String(r.id),
        createdAt: iso(r.created_at)!,
        userId: String(r.user_id),
        userName: (r.user_name as string) ?? null,
        userEmail: (r.user_email as string) ?? null,
        userPhone: (r.user_phone as string) ?? null,
        userActive: r.user_active == null ? null : Boolean(r.user_active),
        employeeName: (r.employee_name as string) ?? null,
        employeeCode: (r.employee_code as string) ?? null,
        purpose: String(r.purpose),
        surface: (r.surface as string) ?? null,
        requestedWith: (r.requested_with as string) ?? null,
        destination: String(r.destination ?? ""),
        provider: (r.provider as string) ?? null,
        providerRef: (r.provider_ref as string) ?? null,
        providerResponse: r.provider_response ?? null,
        sentAt: iso(r.sent_at),
        expiresAt: iso(r.expires_at)!,
        consumedAt: iso(r.consumed_at),
        attempts: Number(r.attempts ?? 0),
        lastAttemptAt: iso(r.last_attempt_at),
        lastAttemptResult: (r.last_attempt_result as string) ?? null,
        failureReason: (r.failure_reason as string) ?? null,
        refusedReason: (r.refused_reason as string) ?? null,
        requestIp: (r.request_ip as string) ?? null,
        userAgent: (r.user_agent as string) ?? null,
        status: String(r.status) as OtpStatus,
      }),
    ),
  };
}

export type OtpPersonRow = {
  userId: string;
  name: string | null;
  email: string | null;
  employeeName: string | null;
  employeeCode: string | null;
  numbers: string[];
  requests: number;
  sent: number;
  verified: number;
  sendFailed: number;
  refused: number;
  wrongTries: number;
  last24h: number;
  firstAt: string;
  lastAt: string;
};

/**
 * HOW MANY TIMES, PER PERSON — the question "who keeps asking for codes" in
 * one table. Same filters as the list, so a date range or a purpose narrows
 * both the same way. Busiest first.
 */
export async function otpByPerson(filters: OtpHistoryFilters, limit = 200): Promise<OtpPersonRow[]> {
  const config = await getConfig();
  const where = whereOf(filters, Number(config["auth.otp.maxVerifyAttempts"]));
  const rows = await db.execute<Record<string, unknown>>(sql`
    select o.user_id, max(u.name) as name, max(u.email) as email,
           max(e.name) as employee_name, max(e.employee_code) as employee_code,
           array_remove(array_agg(distinct nullif(o.destination, '')), null) as numbers,
           count(*)::int as requests,
           count(*) filter (where o.sent_at is not null)::int as sent,
           count(*) filter (where o.consumed_at is not null)::int as verified,
           count(*) filter (where o.refused_reason is null and o.sent_at is null)::int as send_failed,
           count(*) filter (where o.refused_reason is not null)::int as refused,
           coalesce(sum(o.attempts), 0)::int as wrong_tries,
           count(*) filter (where o.created_at > now() - interval '24 hours')::int as last24h,
           min(o.created_at) as first_at, max(o.created_at) as last_at
    ${FROM}
    where ${where}
    group by o.user_id
    order by count(*) desc, max(o.created_at) desc
    limit ${limit}
  `);
  return rows.map((r) => ({
    userId: String(r.user_id),
    name: (r.name as string) ?? null,
    email: (r.email as string) ?? null,
    employeeName: (r.employee_name as string) ?? null,
    employeeCode: (r.employee_code as string) ?? null,
    numbers: Array.isArray(r.numbers) ? (r.numbers as string[]) : [],
    requests: Number(r.requests),
    sent: Number(r.sent),
    verified: Number(r.verified),
    sendFailed: Number(r.send_failed),
    refused: Number(r.refused),
    wrongTries: Number(r.wrong_tries),
    last24h: Number(r.last24h),
    firstAt: iso(r.first_at)!,
    lastAt: iso(r.last_at)!,
  }));
}
