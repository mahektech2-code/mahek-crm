import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/* ---------------------------------------------------------------------------
 * The access inputs a person's page shows that are SET ELSEWHERE.
 *
 * The Access screen decides apps, levels, screens and powers. Three more
 * things change what somebody can do and are kept by other desks: the HRMS
 * org chart (HR's answer to who manages whom, which also feeds the CRM's
 * sales-manager seats), the ERP's godown staff lists, and the job title in the
 * employee sheet — a Position ending in "Head" hands HRMS's markStaff and
 * checkoutStaff over by position, with no row anywhere on the Access screen.
 * The person page reads them here so an administrator looking at "why can she
 * do that" is told where the answer lives rather than left to guess.
 *
 * Read-only, and one person at a time.
 * ------------------------------------------------------------------------- */

export type PersonAccessExtras = {
  /** The employee row HRMS reads as this person — linked, or a unique email match, the order `lib/hrms/access.ts` uses. */
  employee: { id: string; code: string; name: string; position: string | null } | null;
  /** Who the HRMS org chart says they report to. Usually one name; the chart allows more. */
  orgManagers: string[];
  /** The ERP godowns whose staff list carries them. */
  godowns: string[];
};

export async function personAccessExtras(userId: string): Promise<PersonAccessExtras> {
  /* The employee is found the way HRMS finds it: the deliberate link on the
     account first, and only failing that an email matching exactly one row.
     The Access list also guesses on the work number; HRMS does not, and it is
     HRMS's reading that hands a head their powers, so it is the one shown. */
  const [emp] = (await db.execute(sql`
    with me as (select employee_id, lower(email) as email from users where id = ${userId}),
    linked as (
      select e.id, e.employee_code, e.name, e.position, 1 as pref
        from employees e, me where e.id = me.employee_id
    ),
    by_email as (
      select e.id, e.employee_code, e.name, e.position, 2 as pref
        from employees e, me
       where me.email is not null and lower(e.email) = me.email
         and (select count(*) from employees x where lower(x.email) = me.email) = 1
    )
    select id, employee_code as code, name, position
      from (select * from linked union all select * from by_email) t
     order by pref
     limit 1
  `)) as unknown as Array<{ id: string; code: string; name: string; position: string | null }>;

  const [managers, godowns] = await Promise.all([
    emp
      ? (db.execute(sql`
          select m.name
            from employee_reporting r
            join employees m on m.id = r.manager_id
           where r.employee_id = ${emp.id}
           order by m.name
        `) as unknown as Promise<Array<{ name: string }>>)
      : Promise.resolve([]),
    db.execute(sql`
      select g.name
        from erp_godown_staff s
        join erp_godowns g on g.id = s.godown_id
       where s.user_id = ${userId}
       order by g.name
    `) as unknown as Promise<Array<{ name: string }>>,
  ]);

  return {
    employee: emp ?? null,
    orgManagers: managers.map((m) => m.name),
    godowns: godowns.map((g) => g.name),
  };
}
