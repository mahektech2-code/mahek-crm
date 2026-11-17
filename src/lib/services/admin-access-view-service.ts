import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * What the People & access screen draws beside each person that the access
 * list itself does not carry: when they last signed in, whether a session is
 * live now, and their job in HRMS — plus the HRMS people with no account yet,
 * who are a tab of their own. All read, nothing derived or stored.
 * ------------------------------------------------------------------------- */

export type PersonExtras = {
  /** The last sign-in we know of: the account's own stamp, else the sign-in log. ISO, or null for never. */
  lastSignedIn: string | null;
  /** A session that has not expired. */
  liveNow: boolean;
  /** Their job in HRMS, where the account is matched to an employee. */
  position: string | null;
};

export type NoAccountEmployee = {
  id: string;
  name: string;
  code: string;
  position: string | null;
  phone: string | null;
  email: string | null;
};

export type AccessView = {
  extras: Record<string, PersonExtras>;
  /** Active employees in the HRMS mirror. */
  inHrms: number;
  signedInToday: number;
  liveNow: number;
  /** Active HRMS employees no account is matched to. */
  noAccount: NoAccountEmployee[];
};

export async function accessView(matchedCodes: string[]): Promise<AccessView> {
  const [people, hrms] = await Promise.all([
    db.execute(sql`
      select u.id,
             coalesce(u.last_login_at, (select max(a.signed_in_at) from attendance a where a.user_id = u.id))::text as "lastSignedIn",
             exists (select 1 from sessions s where s.user_id = u.id and s.expires_at > now()) as "liveNow",
             (coalesce(u.last_login_at, (select max(a.signed_in_at) from attendance a where a.user_id = u.id)) at time zone ${APP_TIMEZONE})::date
               = (now() at time zone ${APP_TIMEZONE})::date as "today",
             e.position
        from users u
        left join employees e on e.id = u.employee_id`) as unknown as Promise<
      { id: string; lastSignedIn: string | null; liveNow: boolean; today: boolean | null; position: string | null }[]
    >,
    db.execute(sql`
      select id, name, employee_code as code, position, coalesce(personal_mobile, company_mobile) as phone, email
        from employees
       where status = 'active'
       order by name`) as unknown as Promise<NoAccountEmployee[]>,
  ]);

  const extras: Record<string, PersonExtras> = {};
  for (const p of people) extras[p.id] = { lastSignedIn: p.lastSignedIn, liveNow: !!p.liveNow, position: p.position };
  const matched = new Set(matchedCodes);
  return {
    extras,
    inHrms: hrms.length,
    signedInToday: people.filter((p) => p.today).length,
    liveNow: people.filter((p) => p.liveNow).length,
    noAccount: hrms.filter((e) => !matched.has(e.code)),
  };
}

/* ---------------------------------------------------------------------------
 * The one-person page's side cards: the sign-in facts the account row does not
 * carry, what they hold that disabling leaves behind, and where their
 * one-time codes go. All counted, nothing stored.
 * ------------------------------------------------------------------------- */

export type PersonCard = {
  /** Wrong passwords inside the throttle's own window. */
  wrongPasswords: number;
  /** Their bound handset — model and build — or null. */
  handset: string | null;
  backOffice: number;
  salesBook: number;
  openLeads: number;
  openTasks: number;
  /** The last four digits of the HRMS personal mobile their codes go to. */
  otpLast4: string | null;
  /** Where they work, from HRMS. */
  office: string | null;
};

export async function personCard(userId: string, windowMinutes: number): Promise<PersonCard> {
  const [row] = (await db.execute(sql`
    select
      (select count(*)::int from sign_in_failures f
        where f.account = ${"user:" + userId} and f.at > now() - make_interval(mins => ${windowMinutes}::int)) as "wrongPasswords",
      (select concat_ws(' · ', d.model, d.app_version) from mbos_devices d
        where d.user_id = ${userId} and d.active order by d.bound_at desc nulls last limit 1) as "handset",
      (select count(*)::int from customers c where c.back_office_am_id = ${userId} and c.kind <> 'lead') as "backOffice",
      (select count(*)::int from customers c where c.sales_am_id = ${userId} and c.kind <> 'lead') as "salesBook",
      (select count(*)::int from customers c where c.owner_id = ${userId} and c.kind = 'lead'
        and coalesce(c.lead_stage::text, '') not in ('won', 'lost')) as "openLeads",
      (select count(*)::int from tasks t where t.assignee_id = ${userId} and t.status <> 'done' and t.status <> 'missed') as "openTasks",
      right(regexp_replace(coalesce(e.personal_mobile, ''), '\D', '', 'g'), 4) as "otpLast4",
      e.office_name as "office"
    from users u
    left join employees e on e.id = u.employee_id
   where u.id = ${userId}`)) as unknown as PersonCard[];
  return {
    wrongPasswords: row?.wrongPasswords ?? 0,
    handset: row?.handset || null,
    backOffice: row?.backOffice ?? 0,
    salesBook: row?.salesBook ?? 0,
    openLeads: row?.openLeads ?? 0,
    openTasks: row?.openTasks ?? 0,
    otpLast4: row?.otpLast4 || null,
    office: row?.office ?? null,
  };
}
