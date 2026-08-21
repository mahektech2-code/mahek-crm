import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import {
  oldestApprovalHours,
  pendingApprovals,
  recentDecisions,
} from "@/lib/services/sales-service";
import { ApprovalsScreen } from "./approvals-screen";

export const metadata = { title: "Approvals — Sales Dashboard — MahekOne" };

export default async function Page() {
  const [pending, decided, oldestHours, config] = await Promise.all([
    pendingApprovals(),
    recentDecisions(25),
    oldestApprovalHours(),
    getConfig(),
  ]);

  return (
    <ApprovalsScreen
      pending={pending}
      decided={decided}
      oldestHours={oldestHours}
      // The same threshold accounts are held to for an unconfirmed payment,
      // rather than a second number invented here that would drift from it.
      staleHours={config["payments.confirmationAgeWarningHours"]}
      nowMs={nowMs()}
    />
  );
}
