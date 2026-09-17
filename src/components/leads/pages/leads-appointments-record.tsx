import { type LeadWorkspace } from "@/lib/lead-workspace";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import { approvalRouteReason, gateTo, type LeadGateInput } from "@/lib/engines/lead-gates";
import {
  canLead,
} from "@/lib/services/lead-console-service";
import { distributorAppointmentRecord } from "@/lib/services/distributor-appointment-service";
import { AppointmentRecordScreen } from "@/components/leads/appointments/record/appointment-record-screen";


/**
 * §12 — one distributor candidate, and what two people are being asked to sign.
 *
 * The queue one level up answers "what is waiting". It cannot answer "and
 * should I sign it", because that answer is thirty conditions, a godown, a
 * dealer network, two sets of commercial numbers and whatever the sales manager
 * wrote when he put them up. None of that is a column, and a row that expanded
 * would give a director a six-inch drawer to read an appointment through.
 *
 * **The escalation reason is computed HERE, by `approvalRouteReason`, and never
 * re-derived on the screen.** What forces management's signature is NAMED
 * rather than judged — exclusivity always, a discount above
 * `leads.distributorDiscountApprovalPercent`, a credit limit above
 * `leads.distributorCreditLimitApprovalPaise` — and that function is the one
 * place it is decided. A second copy typed into a panel would drift inside a
 * release, and the half that drifts is the half somebody is reading before they
 * commit the company to a credit limit.
 *
 * **The gate is evaluated here too**, for the same reason the lead record does
 * it: `gateTo` is pure and would run in a browser perfectly well, but the input
 * it takes is the whole application, and shipping that to draw a checklist is
 * how a record page comes to carry a candidate's entire file in its payload.
 *
 * **The clock is read once, here.** The React Compiler rules are on and a
 * client component may not read `Date.now()` during render.
 */
export async function Body({
  workspace,
  params,
}: {
  workspace: LeadWorkspace;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [user, record, config] = await Promise.all([
    requireUser(),
    distributorAppointmentRecord(id),
    getConfig(),
  ]);

  /* Null covers both "no such candidate" and "not in this manager's
     territory", and the two are deliberately one answer — a 404 that told them
     apart would make the URL a way to find out whose book an id belongs to. */
  if (!record) notFound();

  const { candidate, profile } = record;

  /* The gate reads the profile as the stored row, which is exactly what
     `conditionsToEnter` expects — it indexes the camelCase keys this service
     already returns, so nothing is renamed on the way in. */
  const gateInput: LeadGateInput = {
    salesType: candidate.salesType,
    stage: candidate.stage,
    nextAction: candidate.nextAction,
    nextActionDate: candidate.nextActionDate,
    nextActionOwnerId: candidate.nextActionOwnerId,
    distributorProfile: profile as unknown as Record<string, unknown> | null,
  };

  const discountThreshold = config["leads.distributorDiscountApprovalPercent"];
  const creditLimitThresholdPaise = config["leads.distributorCreditLimitApprovalPaise"];

  return (
    <AppointmentRecordScreen workspace={workspace}
      record={record}
      /* Entering `management_review` is what the thirty answers buy, so that is
         the rung the checklist is measured against — not the rung the candidate
         happens to be standing on, which for a stalled application is the one
         below the work. */
      verdict={gateTo(gateInput, "management_review")}
      routeReason={approvalRouteReason(
        profile as unknown as Record<string, unknown> | null,
        { discountPercent: discountThreshold, creditLimitPaise: creditLimitThresholdPaise },
      )}
      discountThreshold={discountThreshold}
      creditLimitThresholdPaise={creditLimitThresholdPaise}
      /* Two capabilities, two different acts. Appointing is management's and
         admin's; changing what is being offered is `distributor.terms`. Both
         are refused in the action as well — a server action is a URL and a
         disabled button is a courtesy, not a permission. */
      canApproveManagement={await canLead(user, "distributor.approve")}
      canChangeTerms={await canLead(user, "distributor.terms")}
      nowMs={nowMs()}
    />
  );
}
