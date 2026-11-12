import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { DEFAULT_PER_PAGE, PER_PAGE_OPTIONS, PERSON_LIST, readTaskQuery } from "@/lib/tasks/list-query";
import { personName, taskListPage, teamWorkload } from "@/lib/tasks/list-service";
import { TaskDialogs } from "../_ui/dialogs";
import { TeamScreen } from "../_ui/screens";

export const metadata = { title: "Team workload" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Everybody below this person on the org chart — or everyone, with the
 * permission — a page of people at a time, and a picked person's tasks a page
 * at a time. `pq`, `pp` and `pper` page the people; the task list's own
 * parameters page the person's tasks.
 */
export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const [sp, day] = await Promise.all([searchParams, today()]);
  const pq = one(sp.pq).trim().slice(0, 80);
  const pp = Math.max(1, Number.parseInt(one(sp.pp), 10) || 1);
  const pper = (PER_PAGE_OPTIONS as readonly number[]).includes(Number(one(sp.pper))) ? Number(one(sp.pper)) : DEFAULT_PER_PAGE;
  const person = one(sp.person) || null;
  const [workload, name] = await Promise.all([teamWorkload(user, day, { q: pq, page: pp, per: pper }), person ? personName(user, person) : Promise.resolve(null)]);
  const query = readTaskQuery(sp, PERSON_LIST);
  const list = person && name ? { query, page: await taskListPage({ kind: "person", personId: person }, query, day) } : null;
  return (
    <TaskDialogs>
      <TeamScreen workload={workload} q={pq} person={name ? person : null} personName={name} list={list} today={day} viewerId={user.id} />
    </TaskDialogs>
  );
}
