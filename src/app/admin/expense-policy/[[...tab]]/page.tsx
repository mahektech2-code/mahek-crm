import { hometownTree } from "@/lib/services/hometown-service";
import { notFound } from "next/navigation";
import { canFor } from "@/lib/access-control";
import { STANDARD_GUIDELINES, STANDARD_POLICY } from "@/lib/expense-policy-standard";
import { ruleToDraft } from "@/lib/expense-policy-sets";
import {
  listPolicySets,
  policyChoices,
  policyPeople,
  policySetRevisions,
  readPolicySet,
} from "@/lib/services/expense-policy-set-service";
import { adminContext } from "../../_shell/context";
import { PoliciesScreen } from "../policies-screen";
import { PolicyEditor } from "../policy-editor";

/**
 * The expense policies.
 *
 * With no segment it is the list of policies and who is on which; with a
 * policy id (`ADMIN.expensePolicy(id)`) it is that policy's editor. The rule builder's old
 * tab addresses (`/rules`, `/versions`, …) are not policy ids and land on the
 * list, as they did when the policy was read-only.
 */
export default async function ExpensePolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const ctx = await adminContext();
  const [{ tab }, query] = await Promise.all([params, searchParams]);
  const canWrite = await canFor(ctx.user, "expense.policy.write");
  const first = tab?.[0];

  if (first && first.startsWith("xpol")) {
    const set = await readPolicySet(first);
    if (!set) notFound();
    const [choices, revisions, people] = await Promise.all([
      policyChoices(),
      policySetRevisions(set.id),
      policyPeople(),
    ]);
    const standardCount = people.filter((p) => p.active && (!p.setId || p.setInactive)).length;
    return (
      /* Keyed on the revision, so a save (or somebody else's) remounts the
         editor with the rules as they now stand rather than a stale draft. */
      <PolicyEditor
        key={`${set.id}:${set.revision}`}
        set={{
          id: set.id,
          name: set.name,
          description: set.description,
          isStandard: set.isStandard,
          active: set.active,
          revision: set.revision,
          unreadable: set.unreadable,
          updatedAt: set.updatedAt,
          updatedByName: set.updatedByName,
          clonedFromName: set.clonedFromName,
          guidelines: set.guidelines,
        }}
        defaultGuidelines={set.isStandard ? [...STANDARD_GUIDELINES] : null}
        drafts={set.rules.map(ruleToDraft)}
        defaults={set.isStandard ? STANDARD_POLICY.rules.map(ruleToDraft) : null}
        choices={choices}
        revisions={revisions}
        members={people
          .filter((p) => p.setId === set.id)
          .map((p) => ({ userId: p.userId, name: p.name, position: p.position }))}
        standardCount={standardCount}
        canWrite={canWrite}
      />
    );
  }

  const [sets, people, towns] = await Promise.all([listPolicySets(), policyPeople(), hometownTree()]);
  return (
    <PoliciesScreen
      sets={sets.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        isStandard: s.isStandard,
        active: s.active,
        ruleCount: s.rules.length,
        memberCount: s.memberCount,
        revision: s.revision,
        updatedAt: s.updatedAt,
        updatedByName: s.updatedByName,
        clonedFromName: s.clonedFromName,
      }))}
      people={people}
      towns={towns}
      canWrite={canWrite}
      initialTab={query.tab === "people" ? "people" : "policies"}
    />
  );
}
