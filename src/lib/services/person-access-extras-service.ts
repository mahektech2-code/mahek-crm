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
  /**
   * The Sales Dashboard's oversight regions on them (`kind = 'region'`), and
   * how many working places (cities, beats) a salesman is allocated besides.
   * EMPTY REGIONS MEAN NATIONAL for a manager-level reader — `managerScope`.
   */
  regions: string[];
  workingPlaces: number;
  /** Whether a manager-level grant in the CRM, the Sales Dashboard or Founder makes the regions decide what they see. */
  regionScoped: boolean;
  /** Live website review assignments: the kind, and the one item where it is narrowed to one. */
  websiteAssignments: string[];
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

  const [managers, godowns, places, website, scoped] = await Promise.all([
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
    db.execute(sql`
      select kind, region from mbos_user_territories where user_id = ${userId} order by region
    `) as unknown as Promise<Array<{ kind: string; region: string }>>,
    db.execute(sql`
      select a.kind, c.slug as key
        from website_assignment a
        left join website_content c on c.id = a.content_id
       where a.employee_id = ${userId} and a.revoked_at is null
       order by a.kind
    `) as unknown as Promise<Array<{ kind: string; key: string | null }>>,
    /* The arm of scopeStanding that reads regions: a manager — not admin —
       on an app whose screens the region scope draws, and not a platform admin. */
    db.execute(sql`
      select exists (select 1 from app_access where user_id = ${userId} and app in ('crm', 'sales', 'founder') and role = 'manager')
         and not exists (select 1 from app_access where user_id = ${userId} and app in ('crm', 'sales', 'founder') and role = 'admin')
         and not exists (select 1 from app_access where user_id = ${userId} and app = 'admin' and role = 'admin') as scoped
    `) as unknown as Promise<Array<{ scoped: boolean }>>,
  ]);

  return {
    employee: emp ?? null,
    orgManagers: managers.map((m) => m.name),
    godowns: godowns.map((g) => g.name),
    regions: places.filter((p) => p.kind === "region").map((p) => p.region),
    workingPlaces: places.filter((p) => p.kind !== "region").length,
    regionScoped: Boolean(scoped[0]?.scoped),
    websiteAssignments: website.map((w) => (w.key ? `${w.kind} · ${w.key}` : `every ${w.kind}`)),
  };
}
