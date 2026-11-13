/**
 * READ-ONLY: who holds the HRMS at MANAGER level, and how much each of them
 * now sees.
 *
 *   npm run report:hrms-managers
 *
 * Since the HRMS was cut to three roles (Nov 2026), a manager sees their TEAM —
 * the people the org chart names them as manager of, plus anybody the chart has
 * not placed whose sheet Report To is their job title — where before they saw
 * everybody. This lists every manager-level grant with that team's size, so
 * whoever runs the Access screen can see who now sees little or nothing and
 * decide whether they should be the HR team (the admin level) instead.
 *
 * It runs SELECTs in a READ ONLY transaction and nothing else: the database
 * itself would refuse a write. It reads whichever DATABASE_URL is set, so run
 * it against production only with that in mind.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";

type Row = {
  name: string;
  email: string | null;
  employee: string | null;
  position: string | null;
  office: string | null;
  linked: string;
  team: number;
  chart: number;
  by_title: number;
  powers: string | null;
};

const REPORT = sql`
  with grants as (
    select u.id as user_id, u.name, u.email, u.employee_id
    from app_access a
    join users u on u.id = a.user_id
    where a.app = 'hrms' and coalesce(a.role, u.role) = 'manager' and u.active
  ),
  linked as (
    select g.*,
      coalesce(
        g.employee_id,
        (select e.id from employees e
           where g.email is not null and lower(e.email) = lower(g.email)
           group by e.id having (select count(*) from employees e2 where lower(e2.email) = lower(g.email)) = 1)
      ) as emp_id,
      case when g.employee_id is not null then 'linked'
           when g.email is not null and (select count(*) from employees e where lower(e.email) = lower(g.email)) = 1 then 'by email'
           else 'NOT LINKED' end as linked
    from grants g
  ),
  teams as (
    select l.user_id,
      (select count(*) from employee_reporting r where r.manager_id = l.emp_id and r.employee_id <> l.emp_id)::int as chart,
      (select count(*) from employees e
         join employees me on me.id = l.emp_id
        where me.position is not null
          and lower(trim(e.reports_to)) = lower(trim(me.position))
          and e.id <> l.emp_id
          and not exists (select 1 from employee_reporting r where r.employee_id = e.id))::int as by_title
    from linked l
  )
  select l.name, l.email, e.name as employee, e.position, e.office_name as office, l.linked,
         coalesce(t.chart, 0) + coalesce(t.by_title, 0) as team,
         coalesce(t.chart, 0) as chart, coalesce(t.by_title, 0) as by_title,
         (select string_agg(p.power, ', ' order by p.power) from hrms_user_powers p where p.user_id = l.user_id) as powers
  from linked l
  left join employees e on e.id = l.emp_id
  left join teams t on t.user_id = l.user_id
  order by team, l.name`;

async function report(run: typeof db) {
  const rows = (await run.execute(REPORT)) as unknown as Row[];
  console.log("\nHRMS manager-level grants — read-only report\n");
  if (!rows.length) {
    console.log("Nobody holds the HRMS at manager level.\n");
    return;
  }
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log(`${pad("Person", 26)}${pad("Job title", 24)}${pad("Office", 16)}${pad("Account", 12)}${"Team".padStart(5)}  Granted powers`);
  for (const r of rows) {
    console.log(
      `${pad(r.name, 26)}${pad(r.position ?? "—", 24)}${pad(r.office ?? "—", 16)}${pad(r.linked, 12)}${String(r.team).padStart(5)}  ${r.powers ?? "—"}`,
    );
  }
  const empty = rows.filter((r) => r.team === 0);
  const unlinked = rows.filter((r) => r.linked === "NOT LINKED");
  console.log(`\n${rows.length} manager-level grants. Team = org-chart reports plus unplaced people whose Report To is their job title.`);
  console.log(`${empty.length} see no team at all — as managers they see only their own records.`);
  if (unlinked.length) console.log(`${unlinked.length} are not linked to an employee record, so they have no team until HR links them.`);
  console.log("A granted power (hr, perfAdmin, approveLeave, …) still widens the list it names to everybody.");
  console.log("Anybody who should see the whole company is the HR team: the admin level on the HRMS grant.\n");
  console.log("Nothing was changed.\n");
}

async function main() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await report(tx as unknown as typeof db);
  });
  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
