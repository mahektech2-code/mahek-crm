import { type LeadWorkspace } from "@/lib/lead-workspace";
import {
  anyTrialFeedbackExists,
  reviewedWithoutFeedback,
  trialFeedback,
  trialFeedbackFacets,
  trialVerdicts,
  type TrialFeedbackFilters,
} from "@/lib/services/sample-trials-service";
import { FeedbackScreen } from "@/components/samples/feedback/feedback-screen";


/**
 * §16's seven answers, across every trial rather than one at a time.
 *
 * "Good" cannot be read back. That is the whole argument for seven columns
 * instead of a notes field, and it only pays off on a screen like this one:
 * "better drying than the incumbent, price is the problem" is a note on one
 * record and a PATTERN across forty, and the pattern is what tells somebody
 * which conversation to have with the factory.
 *
 * **Filtered by product and by competitor, because the comparison is the whole
 * point of a trial.** Both are URL parameters rather than component state: a
 * filtered reading — "every trial against Asian Paints, eleven of them, nine
 * of which said the price was the problem" — is exactly the thing somebody
 * wants to send to somebody else, and holding it in the browser makes that
 * unsendable and the back button a lie.
 *
 * **This screen writes nothing.** It is a library. The one write in the module
 * is `recordSampleFeedback`, and it belongs on the desk and on the chase list,
 * where somebody has just made the call.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<{ product?: string; competitor?: string; outcome?: string }>;
}) {
  const sp = await searchParams;
  const filters: TrialFeedbackFilters = {
    productId: sp.product ?? null,
    competitor: sp.competitor ?? null,
    outcome: sp.outcome ?? null,
  };

  const [rows, facets, verdicts, orphaned, anyAtAll] = await Promise.all([
    trialFeedback(filters),
    trialFeedbackFacets(),
    /* The distribution follows the FILTER, and the chips do not. What somebody
       is asking on this screen is "of the trials against this competitor, how
       many did we lose" — a distribution that ignored the selection would
       answer a question nobody asked, sitting directly above the rows that
       did. */
    trialVerdicts(filters),
    reviewedWithoutFeedback(),
    anyTrialFeedbackExists(),
  ]);

  return (
    <FeedbackScreen workspace={workspace}
      rows={rows}
      facets={facets}
      verdicts={verdicts}
      reviewedWithoutFeedback={orphaned}
      anyFeedbackAtAll={anyAtAll}
      filters={{
        product: sp.product ?? null,
        competitor: sp.competitor ?? null,
        outcome: sp.outcome ?? null,
      }}
    />
  );
}
