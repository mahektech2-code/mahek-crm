import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead, verificationQueue } from "@/lib/services/lead-console-service";
import { VerificationQueueScreen } from "./verification-queue-screen";

export const metadata = { title: "Verification queue — Sales Dashboard — MahekOne" };

/**
 * §7 — the calls a sales manager owes, oldest first.
 *
 * The specification makes this the FIRST thing that happens to a prospect, and
 * the gate to Qualification will not open without it — so this queue is a
 * blockage rather than an opportunity list, and it is sorted as one. Every day
 * a lead sits here is a day its salesman cannot move, whatever the lead is
 * worth.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ who?: string }>;
}) {
  const { who } = await searchParams;
  const mineOnly = who !== "all";

  const day = await today();
  const [user, queue, config] = await Promise.all([
    requireUser(),
    verificationQueue(day),
    getConfig(),
  ]);

  return (
    <VerificationQueueScreen
      rows={queue.rows}
      total={queue.total}
      mineCount={queue.mine}
      mineOnly={mineOnly}
      dueDays={config["leads.verificationDueDays"]}
      canVerify={canLead(user.role, "lead.verify")}
    />
  );
}
