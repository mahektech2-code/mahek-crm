import Link from "next/link";
import { ScreenHeader } from "@/components/console/parts";
import { PolicyView } from "@/components/expenses/policy-view";
import { cx } from "@/components/ui/primitives";
import { policyInWords } from "@/lib/expense-policy-standard";
import { listPolicySets, policyChoices, policyPeople } from "@/lib/services/expense-policy-set-service";

export const metadata = { title: "Expense policy — Sales Dashboard — MahekOne" };

/**
 * What the field is allowed — the same policies the Admin Console edits and
 * the claims are priced with. A manager reads them because he is the person a
 * salesman argues with about a claim. Read-only here: the policies are
 * written on the Admin Console.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ policy?: string }> }) {
  const [{ policy: picked }, sets, choices, people] = await Promise.all([
    searchParams,
    listPolicySets(),
    policyChoices(),
    policyPeople(),
  ]);
  const active = sets.filter((s) => s.active);
  const shown = active.find((s) => s.id === picked) ?? active.find((s) => s.isStandard) ?? active[0];
  const modeLabel = (k: string) => choices.modes.find((m) => m.key === k)?.label;
  const gradeLabel = (k: string) => choices.grades.find((g) => g.key === k)?.label ?? k;
  const onIt = shown
    ? shown.isStandard
      ? people.filter((p) => p.active && (!p.setId || p.setInactive)).length
      : people.filter((p) => p.active && p.setId === shown.id).length
    : 0;

  return (
    <div className="p-6">
      <ScreenHeader
        title="Expense policy"
        subtitle="What a salesman is paid back. Every day is worked out with his own policy's figures before it reaches you."
      />
      {active.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {active.map((s) => (
            <Link
              key={s.id}
              href={`/sales/expense-policy?policy=${s.id}`}
              className={cx(
                "h-8 rounded-[4px] border px-2.5 text-[13px] leading-8 no-underline",
                s.id === shown?.id
                  ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                  : "border-line bg-surface text-body hover:bg-canvas",
              )}
            >
              {s.name}
              {s.isStandard ? " (standard)" : ""}
            </Link>
          ))}
        </div>
      ) : null}
      {shown ? (
        <PolicyView
          sections={policyInWords(shown.rules, { modeLabel, gradeLabel })}
          title={shown.name}
          intro={
            shown.isStandard
              ? `the policy everybody is on unless they are put on another — ${onIt} ${onIt === 1 ? "person" : "people"} right now.`
              : `${onIt} ${onIt === 1 ? "person is" : "people are"} on this policy.${shown.description ? ` ${shown.description}` : ""}`
          }
        />
      ) : null}
    </div>
  );
}
