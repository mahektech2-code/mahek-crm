import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { today } from "@/lib/queries";
import {
  eodFor,
  eodPreflightFor,
  storedEodReport,
  teamEod,
} from "@/lib/services/eod-service";
import { daysBetween } from "@/lib/business-date";
import { EodScreen } from "./eod-screen";

export const metadata = { title: "EOD report - MahekOne CRM" };

export default async function EodPage() {
  const user = await requireUser();
  const scope = await getScope(user);
  const day = await today();

  const [report, preflight, submitted, team] = await Promise.all([
    eodFor(user.id, day),
    eodPreflightFor(user.id, day),
    storedEodReport(user.id, day),
    isManager(user) ? teamEod(day) : Promise.resolve(null),
  ]);

  return (
    <EodScreen
      scopeLabel={scopeLabel(scope, user)}
      day={day}
      isManager={isManager(user)}
      lines={report.lines.map((l) => ({ k: l.label, v: l.value }))}
      message={report.whatsappText}
      // The gate: reminders due today that are still open block finalisation.
      dueReminders={preflight.blocking.map((r) => ({
        id: r.id,
        note: r.note,
        dueDate: r.dueDate,
        customerName: r.customerName,
        overdueDays: Math.max(0, daysBetween(r.dueDate, day)),
      }))}
      blockingMessage={preflight.message}
      submittedAt={submitted?.finalisedAt ? submitted.finalisedAt.toISOString() : null}
      team={(team?.rows ?? []).map((t) => ({
        name: t.userName,
        calls: t.callsAttempted,
        connected: t.callsConnected,
        missed: t.callsMissed,
        orders: t.ordersCount,
        value: t.ordersValue,
        percent: t.targetPercent,
      }))}
      teamMessage={team?.whatsappText ?? null}
    />
  );
}
