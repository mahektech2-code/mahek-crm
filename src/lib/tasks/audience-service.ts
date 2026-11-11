import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { audienceChoices, resolveAudience, type Audience, type AudienceChoices, type AudiencePerson } from "./audience";
import { orgManagerMap, teamOf } from "./service";

/* ---------------------------------------------------------------------------
 * THE PEOPLE AN AUDIENCE CAN REACH, read from the database.
 *
 * Candidates are the active people who hold the task's app — Tasks itself for
 * a personal task — and who are the giver or somebody under the giver on the
 * org chart (everybody, for a platform administrator). Each carries what a
 * rule can match on: their level in that app, their HRMS designation and
 * department, their ERP designation, and the managers above them.
 *
 * It is asked when the builder opens, again when the task is saved (the
 * screen's preview is never trusted), and by the routine job on every day a
 * routine runs — which is what makes a routine for "every Telecaller" reach a
 * Telecaller who joined last week.
 * ------------------------------------------------------------------------- */

type Giver = { id: string; role: string };

export async function audienceCandidates(giver: Giver, app: string): Promise<{ people: AudiencePerson[]; names: Map<string, string> }> {
  const [team, managerOf] = await Promise.all([teamOf(giver), orgManagerMap()]);
  const reach = [giver.id, ...team];
  const rows = await db.execute<{
    id: string;
    name: string;
    level: string | null;
    designation: string | null;
    department: string | null;
    erp_designation: string | null;
  }>(sql`
    select u.id, u.name, a.role as level, e.position as designation, e.department, d.name as erp_designation
      from users u
      join app_access a on a.user_id = u.id and a.app::text = ${app}
      left join employees e on e.id = u.employee_id
      left join erp_user_designations ud on ud.user_id = u.id
      left join erp_designations d on d.id = ud.designation_id
     where u.active = true
       and u.id in (${sql.join(reach.map((id) => sql`${id}`), sql`, `)})
     order by u.name`);

  const chain = (id: string) => {
    const out: string[] = [];
    let at = managerOf.get(id);
    while (at && !out.includes(at) && out.length < 30) {
      out.push(at);
      at = managerOf.get(at);
    }
    return out;
  };
  const people: AudiencePerson[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    level: r.level ?? null,
    designation: r.designation ?? null,
    department: r.department ?? null,
    erpDesignation: r.erp_designation ?? null,
    managers: chain(r.id),
  }));

  const managerIds = [...new Set(people.flatMap((p) => p.managers))];
  const names = new Map<string, string>();
  if (managerIds.length) {
    const ms = await db.execute<{ id: string; name: string }>(sql`select id, name from users where id in (${sql.join(managerIds.map((id) => sql`${id}`), sql`, `)})`);
    for (const m of ms) names.set(m.id, m.name);
  }
  // A team is offered only where the giver may reach it: their own, or one under them.
  for (const id of [...names.keys()]) if (id !== giver.id && !team.has(id)) names.delete(id);
  return { people, names };
}

export type AudienceOptions = {
  people: AudiencePerson[];
  choices: AudienceChoices;
};

export async function audienceOptions(giver: Giver, app: string): Promise<AudienceOptions> {
  const { people, names } = await audienceCandidates(giver, app);
  return { people, choices: audienceChoices(people, names) };
}

/** Who an audience reaches today, for this giver and app. */
export async function resolveFor(giver: Giver, app: string, audience: Audience): Promise<string[]> {
  const { people } = await audienceCandidates(giver, app);
  return resolveAudience(audience, people).ids;
}
