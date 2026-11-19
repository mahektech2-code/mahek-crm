import { redirect } from "next/navigation";
import { founderPageAccess } from "@/lib/command-centre/access";
import { deadlinesOverview } from "@/lib/services/accounts-sla-service";
import { ADMIN } from "@/lib/admin-routes";
import { nowMs } from "@/lib/format";
import { DeadlinesDesk } from "./deadlines-desk";

export const metadata = { title: "Accounts deadlines - HQ - MahekOne" };

/**
 * THE ACCOUNTS DEADLINE, as the founder reads it: what the ledger desk has
 * not decided inside its working-hours deadline, the reasons they gave and
 * when they said they would look again, and what was decided late in the
 * last thirty days. Acknowledging or nudging never moves the work — it stays
 * the accounts desk's until they decide it.
 */
export default async function AccountsDeadlinesPage() {
  const access = await founderPageAccess();
  if (!access.allowed.includes("deadlines")) redirect("/founder");
  const overview = await deadlinesOverview(30);
  return (
    <DeadlinesDesk
      overview={overview}
      canAct={access.level === "admin" || access.level === "manager"}
      settingsHref={access.level === "admin" ? ADMIN.settingsFor("accounts", "payments") : null}
      nowMs={nowMs()}
    />
  );
}
