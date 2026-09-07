import "server-only";
import {
  listCityClasses,
  listGrades,
  listGradeMappings,
  listPolicies,
  readPolicy,
  unclassifiedCities,
  unmappedPositions,
  type CityClassRow,
  type GradeMappingRow,
  type GradeRow,
  type PolicyDetail,
  type PolicySummary,
  type UnmappedPosition,
} from "@/lib/services/expense-policy-service";
import { policyReadiness } from "@/lib/actions/expense-policy";

/**
 * Everything the Expense policy section renders, read on the server with the
 * rest of the console's data so the section arrives rendered rather than
 * fetching for itself. Same shape as `catalogue-data.ts`.
 */
export type ExpensePolicyData = {
  /**
   * Today, and a month back, resolved on the SERVER.
   *
   * The simulator's date boxes need defaults, and reading the clock during a
   * client render is impure — the React Compiler rules in this repo refuse it,
   * and they are right to: a component that re-renders at midnight would
   * silently change what it is about. `AGENTS.md` states the rule; this is it
   * being obeyed rather than worked around.
   */
  today: string;
  monthAgo: string;
  versions: PolicySummary[];
  /** The one being edited, or the one in force where nothing is being edited. */
  detail: PolicyDetail | null;
  readiness: { problems: string[]; warnings: string[] } | null;
  grades: GradeRow[];
  mappings: GradeMappingRow[];
  unmapped: UnmappedPosition[];
  cities: CityClassRow[];
  unclassified: { city: string; customerCount: number }[];
  canWrite: boolean;
  canPublish: boolean;
};

export async function expensePolicyData(
  today: string,
  selectedId: string | undefined,
  canWrite: boolean,
  canPublish: boolean,
): Promise<ExpensePolicyData> {
  const versions = await listPolicies(today);
  /* A draft first if there is one: it is the thing somebody came here to work
     on. Otherwise whatever is in force, which is what somebody came here to
     read. Never simply "the newest", which on a fresh deployment is a draft
     nobody has touched. */
  const chosen =
    selectedId ??
    versions.find((v) => v.status === "draft")?.id ??
    versions.find((v) => v.inForce)?.id ??
    versions[0]?.id;

  const [detail, grades, mappings, unmapped, cities, unclassified] = await Promise.all([
    chosen ? readPolicy(chosen, today) : Promise.resolve(null),
    listGrades(),
    listGradeMappings(),
    unmappedPositions(),
    listCityClasses(),
    unclassifiedCities(30),
  ]);

  return {
    today,
    monthAgo: new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000)
      .toISOString()
      .slice(0, 10),
    versions,
    detail,
    readiness: chosen && detail?.policy.status === "draft" ? await policyReadiness(chosen) : null,
    grades,
    mappings,
    unmapped,
    cities,
    unclassified,
    canWrite,
    canPublish,
  };
}
