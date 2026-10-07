import { ScreenHeader } from "@/components/console/parts";
import { PolicyView } from "@/components/expenses/policy-view";

export const metadata = { title: "Expense policy — Sales Dashboard — MahekOne" };

/**
 * What the field is allowed — the same page the Admin Console shows, from the
 * same hard-coded policy the claims are priced with. A manager reads it
 * because he is the person a salesman argues with about a claim.
 */
export default function Page() {
  return (
    <div className="p-6">
      <ScreenHeader
        title="Expense policy"
        subtitle="What a salesman is paid back. Every day is worked out with these figures before it reaches you."
      />
      <PolicyView />
    </div>
  );
}
