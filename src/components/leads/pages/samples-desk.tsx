import { type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead, sampleDesk } from "@/lib/services/lead-console-service";
import { SampleDeskScreen } from "@/components/samples/desk/sample-desk-screen";


/**
 * §15 §16 — the whole life of a sample, on one desk.
 *
 * The Samples screen beside this one answers the single question a manager asks
 * in passing — what has no feedback. This is the desk BEHIND it: approve the
 * request, record the dispatch and the docket, watch the delivery against what
 * the courier promised, read what the customer actually said. They are separate
 * screens rather than more columns because they are separate jobs at separate
 * hours, and a table wide enough for both is one nobody reads either half of.
 *
 * No layout of its own: it inherits the `sales.samples` module guard from the
 * folder above, which is right — somebody who may not see samples may not see
 * the desk that moves them either.
 */
export async function Body({
  workspace,
}: {
  workspace: LeadWorkspace;
}) {
  const user = await requireUser();
  const day = await today();
  const [rows, config] = await Promise.all([sampleDesk(day), getConfig()]);

  return (
    <SampleDeskScreen workspace={workspace}
      rows={rows}
      chaseDays={config["leads.sampleReviewChaseDays"]}
      /* Mahek's eight, read from CONFIGURATION rather than from the literal in
         `lead-labels.ts`. The action validates against what is configured, so
         a picker built from the constant would offer a code the server refuses
         on any deployment where somebody has reworded the list. */
      cancelReasons={config["leads.sampleCancelReasons"]}
      /* Resolved here rather than in the screen, like every other capability
         in this module: a "use client" component cannot ask, and a control
         drawn for somebody the action refuses is worse than no control. */
      canWork={await canLead(user, "lead.work")}
    />
  );
}
