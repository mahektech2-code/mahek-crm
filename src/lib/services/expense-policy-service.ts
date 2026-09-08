import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  expenseCityClasses,
  expenseGrades,
  expensePolicies,
  expensePolicyRules,
} from "@/db/schema";
import { parseRule, describeRule } from "@/lib/expense-rule-forms";
import {
  IN_FORCE_STATUSES,
  isInForceOn,
  policyOn,
  type Policy,
  type PolicySubject,
} from "@/lib/engines/expense-policy";
import { asDate } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * Reading the expense policy, and working out which one applies to whom.
 *
 * The engine is pure and takes a `Policy`; this is where one is assembled from
 * rows and where a person and a trip become the `PolicySubject` the rules are
 * matched against. Nothing here computes an eligible amount — that is the
 * engine's, and it is the engine's in both places.
 * ------------------------------------------------------------------------- */

export type PolicySummary = {
  id: string;
  versionNo: number;
  title: string;
  status: "draft" | "published" | "superseded" | "archived";
  effectiveFrom: string;
  effectiveTo: string | null;
  ruleCount: number;
  sourceAttachmentId: string | null;
  notes: string | null;
  publishedAt: string | null;
  publishedByName: string | null;
  /** True where this version is the one in force today. */
  inForce: boolean;
};

export type PolicyRuleRow = {
  id: string;
  kind: string;
  scopeKey: string;
  grade: string | null;
  cityClass: string | null;
  valueJson: Record<string, unknown>;
  sequence: number;
  /** The rule in English. Null where this release cannot read the kind. */
  sentence: string | null;
};

export type PolicyDetail = {
  policy: PolicySummary;
  rules: PolicyRuleRow[];
  /**
   * Rules this release does not know how to read.
   *
   * Counted rather than hidden and never thrown on. A row written by a later
   * release, or a kind since renamed, is a real thing to meet on a running
   * deployment — and the honest answer is "there are two rules here this
   * screen cannot show you", not a blank policy or a crash on a page somebody
   * is being paid against.
   */
  unreadableCount: number;
};

/* ------------------------------------------------------------- the list */

export async function listPolicies(today: string): Promise<PolicySummary[]> {
  const rows = await db.execute<{
    id: string;
    versionNo: number;
    title: string;
    status: PolicySummary["status"];
    effectiveFrom: string;
    effectiveTo: string | null;
    ruleCount: number;
    sourceAttachmentId: string | null;
    notes: string | null;
    publishedAt: unknown;
    publishedByName: string | null;
  }>(sql`
    select p.id, p.version_no as "versionNo", p.title, p.status::text as status,
           p.effective_from::text as "effectiveFrom",
           p.effective_to::text as "effectiveTo",
           (select count(*)::int from expense_policy_rules r where r.policy_id = p.id) as "ruleCount",
           p.source_attachment_id as "sourceAttachmentId",
           p.notes,
           p.published_at as "publishedAt",
           u.name as "publishedByName"
      from expense_policies p
      left join users u on u.id = p.published_by_id
     order by p.version_no desc
  `);

  return rows.map((r) => ({
    ...r,
    publishedAt: asDate(r.publishedAt)?.toISOString() ?? null,
    inForce: isInForceOn(r, today),
  }));
}

export async function readPolicy(id: string, today: string): Promise<PolicyDetail | null> {
  const list = await listPolicies(today);
  const policy = list.find((p) => p.id === id);
  if (!policy) return null;

  const rows = await db
    .select({
      id: expensePolicyRules.id,
      kind: expensePolicyRules.kind,
      scopeKey: expensePolicyRules.scopeKey,
      grade: expensePolicyRules.grade,
      cityClass: expensePolicyRules.cityClass,
      valueJson: expensePolicyRules.valueJson,
      sequence: expensePolicyRules.sequence,
    })
    .from(expensePolicyRules)
    .where(eq(expensePolicyRules.policyId, id))
    .orderBy(asc(expensePolicyRules.kind), asc(expensePolicyRules.scopeKey), asc(expensePolicyRules.sequence));

  let unreadableCount = 0;
  const rules: PolicyRuleRow[] = rows.map((r) => {
    const parsed = parseRule(r);
    if (!parsed) unreadableCount++;
    return { ...r, sentence: parsed ? describeRule(parsed) : null };
  });

  return { policy, rules, unreadableCount };
}

/* ---------------------------------------------------- assembling a Policy */

/**
 * Every version as the engine sees it.
 *
 * Both statuses are loaded because `policyOn` is what decides which one covers
 * a date, and a SUPERSEDED version still covers the dates it was in force for
 * — that is the whole of requirement 6. Dropping it here would leave every
 * expense older than the current version with no policy at all.
 */
async function loadPolicies(statuses: readonly string[]): Promise<Policy[]> {
  const rows = await db.execute<{
    id: string;
    versionNo: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    kind: string | null;
    scopeKey: string | null;
    grade: string | null;
    cityClass: string | null;
    valueJson: Record<string, unknown> | null;
  }>(sql`
    select p.id, p.version_no as "versionNo",
           p.effective_from::text as "effectiveFrom",
           p.effective_to::text as "effectiveTo",
           r.kind, r.scope_key as "scopeKey", r.grade, r.city_class as "cityClass",
           r.value_json as "valueJson"
      from expense_policies p
      left join expense_policy_rules r on r.policy_id = p.id
     where p.status = any(${sql.raw(`array[${statuses.map((s) => `'${s}'`).join(",")}]::expense_policy_status[]`)})
     order by p.version_no desc, r.sequence asc
  `);

  const byId = new Map<string, Policy>();
  for (const row of rows) {
    let policy = byId.get(row.id);
    if (!policy) {
      policy = {
        id: row.id,
        versionNo: row.versionNo,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        rules: [],
      };
      byId.set(row.id, policy);
    }
    if (row.kind === null) continue;
    const parsed = parseRule({
      kind: row.kind,
      scopeKey: row.scopeKey ?? "",
      grade: row.grade,
      cityClass: row.cityClass,
      valueJson: row.valueJson ?? {},
    });
    if (parsed) (policy.rules as ReturnType<typeof parseRule>[]).push(parsed);
  }
  return [...byId.values()];
}

/** The policy in force on a date, assembled for the engine. Null where none is. */
export async function policyForDate(onDate: string): Promise<Policy | null> {
  const policies = await loadPolicies(IN_FORCE_STATUSES);
  return policyOn(policies, onDate);
}

/** A draft, assembled for the engine — what the simulator runs against. */
export async function draftPolicy(id: string): Promise<Policy | null> {
  const policies = await loadPolicies(["draft", "published", "superseded", "archived"]);
  return policies.find((p) => p.id === id) ?? null;
}

/* ----------------------------------------------------- grades and cities */

export type GradeRow = {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
  isResidual: boolean;
  active: boolean;
};

export async function listGrades(): Promise<GradeRow[]> {
  return db
    .select()
    .from(expenseGrades)
    .orderBy(asc(expenseGrades.sortOrder), asc(expenseGrades.label));
}

export function normaliseKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export type GradeMappingRow = {
  id: string;
  positionNormalised: string;
  positionRaw: string | null;
  gradeId: string;
  gradeLabel: string;
  /** How many people HRMS currently has on this position. */
  peopleCount: number;
};

export async function listGradeMappings(): Promise<GradeMappingRow[]> {
  return db.execute<GradeMappingRow>(sql`
    select m.id, m.position_normalised as "positionNormalised",
           m.position_raw as "positionRaw", m.grade_id as "gradeId",
           g.label as "gradeLabel",
           (select count(*)::int from employees e
             where lower(regexp_replace(coalesce(e.position, ''), '\\s+', ' ', 'g')) = m.position_normalised
               and e.status = 'active') as "peopleCount"
      from expense_grade_map m
      join expense_grades g on g.id = m.grade_id
     order by m.position_normalised asc
  `);
}

export type UnmappedPosition = { position: string; normalised: string; peopleCount: number };

/**
 * Positions HRMS holds that no mapping names.
 *
 * These are not an error and they are not hidden: whoever is on one is paid on
 * the RESIDUAL grade, which is a real, ordinary answer — and somebody being
 * paid on a rule nobody chose for them is exactly the row that must not be
 * silent. The catalogue's Duplicates screen sets the precedent: a row nobody
 * can account for is listed, not dropped on the floor.
 */
export async function unmappedPositions(): Promise<UnmappedPosition[]> {
  return db.execute<UnmappedPosition>(sql`
    select coalesce(e.position, '') as position,
           lower(regexp_replace(coalesce(e.position, ''), '\\s+', ' ', 'g')) as normalised,
           count(*)::int as "peopleCount"
      from employees e
     where e.status = 'active'
       and coalesce(e.position, '') <> ''
       and lower(regexp_replace(coalesce(e.position, ''), '\\s+', ' ', 'g')) not in (
             select position_normalised from expense_grade_map)
     group by 1, 2
     order by 3 desc, 1 asc
  `);
}

export type CityClassRow = {
  id: string;
  cityNormalised: string;
  cityRaw: string | null;
  cityClass: string;
  /** Customers on the book in this city, so a class can be set where it matters. */
  customerCount: number;
};

export async function listCityClasses(): Promise<CityClassRow[]> {
  return db.execute<CityClassRow>(sql`
    select c.id, c.city_normalised as "cityNormalised", c.city_raw as "cityRaw",
           c.city_class as "cityClass",
           (select count(*)::int from customers cu
             where lower(regexp_replace(coalesce(cu.city, ''), '\\s+', ' ', 'g')) = c.city_normalised)
             as "customerCount"
      from expense_city_classes c
     order by c.city_class asc, c.city_normalised asc
  `);
}

/** Cities the book has that no class names. They fall to the residual rule. */
export async function unclassifiedCities(limit = 50): Promise<{ city: string; customerCount: number }[]> {
  return db.execute<{ city: string; customerCount: number }>(sql`
    select cu.city, count(*)::int as "customerCount"
      from customers cu
     where coalesce(cu.city, '') <> ''
       and lower(regexp_replace(cu.city, '\\s+', ' ', 'g')) not in (
             select city_normalised from expense_city_classes)
     group by 1
     order by 2 desc, 1 asc
     limit ${limit}
  `);
}

/* ------------------------------------------------------------- the subject */

/**
 * Who this person is, as far as the policy is concerned.
 *
 * The grade comes from HRMS's `position` through the mapping, falling to the
 * residual grade where nothing matches — the residual exists so that this
 * function always has an answer, because "no grade" would mean no rule matched
 * and no rule matched means paid nothing.
 *
 * The class is a fact about WHERE HE WENT rather than where he is posted: the
 * rules it feeds are a hotel ceiling and a meal allowance, and both are about
 * what things cost where somebody is standing. On a local day the destination
 * is the home city, so one rule resolves both.
 */
export async function resolveSubject(
  userId: string,
  destinationCity: string | null,
): Promise<PolicySubject & { gradeSource: "mapped" | "residual" | "none"; positionRaw: string | null }> {
  const [gradeRow] = await db.execute<{
    gradeKey: string | null;
    positionRaw: string | null;
    residualKey: string | null;
  }>(sql`
    select g.key as "gradeKey", e.position as "positionRaw",
           (select key from expense_grades where is_residual limit 1) as "residualKey"
      from users u
      left join employees e
             on lower(e.email) = lower(u.email)
             or (e.company_mobile is not null and e.company_mobile = u.phone)
      left join expense_grade_map m
             on m.position_normalised = lower(regexp_replace(coalesce(e.position, ''), '\\s+', ' ', 'g'))
      left join expense_grades g on g.id = m.grade_id
     where u.id = ${userId}
     limit 1
  `);

  const cityClass = destinationCity ? await classOfCity(destinationCity) : null;

  if (!gradeRow) return { grade: null, cityClass, gradeSource: "none", positionRaw: null };
  if (gradeRow.gradeKey) {
    return { grade: gradeRow.gradeKey, cityClass, gradeSource: "mapped", positionRaw: gradeRow.positionRaw };
  }
  return {
    grade: gradeRow.residualKey,
    cityClass,
    gradeSource: gradeRow.residualKey ? "residual" : "none",
    positionRaw: gradeRow.positionRaw,
  };
}

export async function classOfCity(city: string): Promise<string | null> {
  const key = normaliseKey(city);
  if (!key) return null;
  const [row] = await db
    .select({ cityClass: expenseCityClasses.cityClass })
    .from(expenseCityClasses)
    .where(eq(expenseCityClasses.cityNormalised, key))
    .limit(1);
  return row?.cityClass ?? null;
}

/**
 * The whole answer for one person on one day: which policy, and under what.
 *
 * This is what the claim path and the handset's pull both call, so the version
 * a salesman was shown and the version his claim is paid on are one lookup
 * rather than two readings of the same question.
 */
export async function policyForUserOn(
  userId: string,
  onDate: string,
  destinationCity: string | null,
): Promise<{ policy: Policy | null; subject: PolicySubject; gradeSource: string }> {
  const [policy, subject] = await Promise.all([
    policyForDate(onDate),
    resolveSubject(userId, destinationCity),
  ]);
  return { policy, subject: { grade: subject.grade, cityClass: subject.cityClass }, gradeSource: subject.gradeSource };
}

/** The next version number. Versions are consecutive and never reused. */
export async function nextVersionNo(): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${expensePolicies.versionNo}), 0)::int` })
    .from(expensePolicies);
  return (row?.max ?? 0) + 1;
}

/**
 * The version whose open end a new one would close.
 *
 * Read off `listPolicies` rather than asked of the database again. It was its
 * own query with its own copy of the predicate, and the copy was wrong in the
 * one way that matters: it named `published` only, so the moment a revision
 * was SCHEDULED the version still pricing today's claims went to `superseded`
 * and this answered null. A publish then found nothing to supersede, and a
 * correction dated inside the live window was refused by the exclusion
 * constraint with the driver's own words.
 *
 * A handful of rows, so the extra rule count per row costs nothing next to
 * having one definition instead of two.
 */
export async function currentlyInForce(
  onDate: string,
): Promise<{ id: string; versionNo: number; effectiveFrom: string } | null> {
  const covering = (await listPolicies(onDate))
    .filter((v) => v.inForce)
    .sort((a, b) => b.versionNo - a.versionNo);
  const winner = covering[0];
  return winner
    ? { id: winner.id, versionNo: winner.versionNo, effectiveFrom: winner.effectiveFrom }
    : null;
}

/**
 * The earliest version already in force ON OR AFTER a date.
 *
 * A new version is given no end date, so putting one in front of a version
 * that already follows it would leave two open-ended policies overlapping —
 * which the exclusion constraint refuses, in words about GiST indexes. This
 * lets the refusal name the version actually in the way.
 */
export async function firstInForceOnOrAfter(
  onDate: string,
): Promise<{ versionNo: number; effectiveFrom: string } | null> {
  const later = (await listPolicies(onDate))
    .filter(
      (v) =>
        (IN_FORCE_STATUSES as readonly string[]).includes(v.status) && v.effectiveFrom >= onDate,
    )
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const first = later[0];
  return first ? { versionNo: first.versionNo, effectiveFrom: first.effectiveFrom } : null;
}
