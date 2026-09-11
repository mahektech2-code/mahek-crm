import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import { appointmentQueue, canLead } from "@/lib/services/lead-console-service";
import { AppointmentsScreen } from "./appointments-screen";

export const metadata = { title: "Distributor appointments — Sales Dashboard — MahekOne" };

/**
 * §12 — appointing a distributor, in two steps with two people.
 *
 * Step 0 is the sales manager, who knows the territory. Step 1 is management,
 * and it exists because a special discount, a credit limit or territory
 * exclusivity are decisions with a cost attached — the person carrying the
 * target should not be the one allowing them.
 *
 * `distributor.approve` is admin's. It is checked in the action; the screen
 * disables what a manager may not press and says why, which is a courtesy on
 * top rather than the enforcement.
 */
export default async function Page() {
  const [user, rows, config] = await Promise.all([
    requireUser(),
    appointmentQueue(),
    getConfig(),
  ]);

  return (
    <AppointmentsScreen
      rows={rows}
      canApproveManagement={await canLead(user, "distributor.approve")}
      discountThreshold={config["leads.distributorDiscountApprovalPercent"]}
      creditLimitThresholdPaise={config["leads.distributorCreditLimitApprovalPaise"]}
      staleHours={config["payments.confirmationAgeWarningHours"]}
      nowMs={nowMs()}
    />
  );
}
