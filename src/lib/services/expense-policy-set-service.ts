import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { employeeLateral } from "@/lib/employee-link";
import { asDate } from "@/lib/business-date";
import type { Policy, PolicyRule } from "@/lib/engines/expense-policy";
import { STANDARD_POLICY, STANDARD_POLICY_ID, STANDARD_POLICY_TITLE } from "@/lib/expense-policy-standard";
import { readStoredRules } from "@/lib/expense-policy-sets";

/* ---------------------------------------------------------------------------
 * Named expense policies — reading them, and working out whose is whose.
 *
 * The standard policy is a ROW like any other, written the first time it is
 * asked for from the code's defaults (`STANDARD_POLICY`). From then on the row
 * is the policy and the code is only what "Reset to defaults" goes back to.
 *
 * A salesman is on the standard policy unless `expense_policy_assignments`
 * names another ACTIVE one for him. A deactivated policy hands its people back
 * to standard without anybody having to move them — the assignment stays, so
 * re-activating it puts them back.
 * ------------------------------------------------------------------------- */

export type PolicySetRow = {
  id: string;
  name: string;
  description: string | null;
  isStandard: boolean;
  active: boolean;
  rules: PolicyRule[];
  unreadable: number;
  revision: number;
  clonedFromId: string | null;
  clonedFromName: string | null;
  createdAt: string | null;
  createdByName: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  /** People assigned to it. Zero for standard, which is everybody else. */
  memberCount: number;
};

type RawSet = {
  id: string;
  name: string;
  description: string | null;
  isStandard: boolean;
  active: boolean;
  rules: unknown;
  revision: number;
  clonedFromId: string | null;
  clonedFromName: string | null;
  createdAt: unknown;
  createdByName: string | null;
  updatedAt: unknown;
  updatedByName: string | null;
  memberCount: number;
};

function shape(r: RawSet): PolicySetRow {
  const { rules, unreadable } = readStoredRules(r.rules);
  return {
    ...r,
    rules,
    unreadable,
    createdAt: asDate(r.createdAt)?.toISOString() ?? null,
    updatedAt: asDate(r.updatedAt)?.toISOString() ?? null,
  };
}

const SET_COLUMNS = sql`
  s.id, s.name, s.description, s.is_standard as "isStandard", s.active, s.rules,
  s.revision, s.cloned_from_id as "clonedFromId", src.name as "clonedFromName",
  s.created_at as "createdAt", cu.name as "createdByName",
  s.updated_at as "updatedAt", uu.name as "updatedByName",
  (select count(*)::int from expense_policy_assignments a where a.set_id = s.id) as "memberCount"
`;
const SET_FROM = sql`
  from expense_policy_sets s
  left join expense_policy_sets src on src.id = s.cloned_from_id
  left join users cu on cu.id = s.created_by_id
  left join users uu on uu.id = s.updated_by_id
`;

/**
 * Make sure the standard policy has its row, and its anchor.
 *
 * Idempotent and cheap once done: one `insert … on conflict do nothing`. It is
 * the reason a fresh database, a truncated test database and a deployment
 * that never ran the editor all price days the same way they did when the
 * policy lived only in code.
 */
export async function ensureStandardSet(): Promise<void> {
  await db.execute(sql`
    insert into expense_policy_sets (id, name, description, is_standard, active, rules, revision)
    values (${STANDARD_POLICY_ID}, ${STANDARD_POLICY_TITLE},
            'The policy every field salesman is on unless he is put on another one.',
            true, true, ${JSON.stringify(STANDARD_POLICY.rules)}::jsonb, 1)
    on conflict do nothing
  `);
  await db.execute(sql`
    insert into expense_policy_set_revisions (id, set_id, revision, name, description, rules, note)
    select 'xpsr_' || s.id || '_1', s.id, 1, s.name, s.description, s.rules, 'The standard policy as it shipped.'
      from expense_policy_sets s
     where s.id = ${STANDARD_POLICY_ID}
       and not exists (select 1 from expense_policy_set_revisions r where r.set_id = s.id)
    on conflict do nothing
  `);
}

export async function listPolicySets(): Promise<PolicySetRow[]> {
  await ensureStandardSet();
  const rows = await db.execute<RawSet>(sql`
    select ${SET_COLUMNS} ${SET_FROM}
     order by s.is_standard desc, s.active desc, lower(s.name) asc
  `);
  return rows.map(shape);
}

export async function readPolicySet(id: string): Promise<PolicySetRow | null> {
  await ensureStandardSet();
  const [row] = await db.execute<RawSet>(sql`select ${SET_COLUMNS} ${SET_FROM} where s.id = ${id} limit 1`);
  return row ? shape(row) : null;
}

/** A set as the engine takes it. Named policies have no dates: they apply to every day. */
export function policyOfSet(set: Pick<PolicySetRow, "id" | "revision" | "rules">): Policy {
  return { id: set.id, versionNo: set.revision, effectiveFrom: "2000-01-01", effectiveTo: null, rules: set.rules };
}

/**
 * The policy this person is under, right now.
 *
 * Their assigned policy where it is active, otherwise standard. One query,
 * and no cache: an edit on the console reaches the next day priced and the
 * next handset pull, which is what "connected" means here.
 */
export async function policySetForUser(userId: string | null): Promise<PolicySetRow> {
  await ensureStandardSet();
  const [row] = await db.execute<RawSet>(sql`
    select ${SET_COLUMNS} ${SET_FROM}
     where s.id = coalesce(
             (select a.set_id
                from expense_policy_assignments a
                join expense_policy_sets x on x.id = a.set_id and x.active
               where a.user_id = ${userId ?? ""}),
             (select id from expense_policy_sets where is_standard limit 1))
     limit 1
  `);
  if (row) return shape(row);
  /* Unreachable once `ensureStandardSet` has run, and still answered rather
     than thrown: a day is always priced. */
  return {
    id: STANDARD_POLICY_ID,
    name: STANDARD_POLICY_TITLE,
    description: null,
    isStandard: true,
    active: true,
    rules: [...STANDARD_POLICY.rules],
    unreadable: 0,
    revision: 1,
    clonedFromId: null,
    clonedFromName: null,
    createdAt: null,
    createdByName: null,
    updatedAt: null,
    updatedByName: null,
    memberCount: 0,
  };
}

/* ------------------------------------------------------------ history */

export type PolicyRevisionRow = {
  id: string;
  revision: number;
  name: string;
  note: string | null;
  ruleCount: number;
  createdAt: string | null;
  createdByName: string | null;
};

export async function policySetRevisions(setId: string): Promise<PolicyRevisionRow[]> {
  const rows = await db.execute<Omit<PolicyRevisionRow, "createdAt"> & { createdAt: unknown }>(sql`
    select r.id, r.revision, r.name, r.note,
           jsonb_array_length(r.rules)::int as "ruleCount",
           r.created_at as "createdAt", u.name as "createdByName"
      from expense_policy_set_revisions r
      left join users u on u.id = r.created_by_id
     where r.set_id = ${setId}
     order by r.revision desc
     limit 200
  `);
  return rows.map((r) => ({ ...r, createdAt: asDate(r.createdAt)?.toISOString() ?? null }));
}

/* ------------------------------------------------------------- people */

export type PolicyPerson = {
  userId: string;
  name: string;
  email: string | null;
  position: string | null;
  active: boolean;
  /** Null means standard. */
  setId: string | null;
  setName: string | null;
  /** True where the assigned policy is switched off, so standard applies. */
  setInactive: boolean;
  assignedAt: string | null;
  assignedByName: string | null;
};

/**
 * Everybody a policy can be given to: whoever holds the field app (the
 * handset), plus anybody already assigned one, so an assignment is never
 * invisible because the app was taken away since.
 */
export async function policyPeople(): Promise<PolicyPerson[]> {
  const rows = await db.execute<Omit<PolicyPerson, "assignedAt"> & { assignedAt: unknown }>(sql`
    select u.id as "userId", u.name, u.email, e.position, u.active,
           a.set_id as "setId", s.name as "setName", coalesce(not s.active, false) as "setInactive",
           a.assigned_at as "assignedAt", ab.name as "assignedByName"
      from users u
      ${employeeLateral("u", "e")}
      left join expense_policy_assignments a on a.user_id = u.id
      left join expense_policy_sets s on s.id = a.set_id
      left join users ab on ab.id = a.assigned_by_id
     where exists (select 1 from app_access g where g.user_id = u.id and g.app = 'field')
        or a.user_id is not null
     order by u.active desc, lower(u.name) asc
  `);
  return rows.map((r) => ({ ...r, assignedAt: asDate(r.assignedAt)?.toISOString() ?? null }));
}

/* ------------------------------------------------------------ choices */

export type PolicyChoices = {
  modes: { key: string; label: string; reimbursementKind: string }[];
  grades: { key: string; label: string }[];
  cityClasses: string[];
};

/** The dropdowns' contents — read, never a list typed into the screen. */
export async function policyChoices(): Promise<PolicyChoices> {
  const [modes, grades, classes] = await Promise.all([
    db.execute<{ key: string; label: string; reimbursementKind: string }>(sql`
      select key, label, reimbursement_kind as "reimbursementKind"
        from mbos_travel_modes order by sort_order asc, label asc
    `),
    db.execute<{ key: string; label: string }>(sql`
      select key, label from expense_grades where active order by sort_order asc, label asc
    `),
    db.execute<{ cityClass: string }>(sql`
      select distinct city_class as "cityClass" from expense_city_classes order by 1
    `),
  ]);
  const classes0 = new Set(["metro", "tier1", "tier2", "other", ...classes.map((c) => c.cityClass)]);
  return { modes: [...modes], grades: [...grades], cityClasses: [...classes0] };
}

/** How many expense days carry a policy's id — what decides whether it may be deleted. */
export async function daysStampedWith(setId: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from mbos_expense_days where policy_id = ${setId}
  `);
  return row?.n ?? 0;
}
