import { isManager, requireUser } from "@/lib/auth";
import { getScope, scopeLabel } from "@/lib/scope";
import { today } from "@/lib/queries";
import { getConfig } from "@/lib/config/store";
import {
  daysBetween,
  eodPeriodRange,
  isEodPeriod,
  type EodPeriod,
} from "@/lib/business-date";
import { eodLines } from "@/lib/engines/eod";
import {
  eodFor,
  eodMetricsForRange,
  eodPreflightFor,
  storedEodReport,
  teamEod,
} from "@/lib/services/eod-service";
import { EodScreen } from "./eod-screen";

export const metadata = { title: "EOD report - MahekOne CRM" };

export default async function EodPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const scope = await getScope(user);
  const day = await today();
  const config = await getConfig();
  const workingDay = {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  };

  // Which span the report is read over. Anything unrecognised in the URL
  // reads as today rather than erroring — a mistyped query string must not be
  // a broken report.
  const params = await searchParams;
  const period: EodPeriod = isEodPeriod(params.period) ? params.period : "today";
  const isDate = (v: string | undefined): v is string =>
    !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const custom = {
    from: isDate(params.from) ? params.from : day,
    to: isDate(params.to) ? params.to : day,
  };
  // A range typed backwards is swapped rather than refused — somebody picking
  // the second date first is the ordinary way it happens.
  const range = eodPeriodRange(
    day,
    period,
    workingDay,
    custom.from <= custom.to
      ? { from: custom.from, to: custom.to }
      : { from: custom.to, to: custom.from },
  );
  const isToday = period === "today";

  // The submit gate and the finalised-today banner are always about the REAL
  // today, whatever period is being viewed — a telecaller browsing "last 7
  // days" has not thereby changed which day's reminders block their next
  // submission.
  const [report, preflight, submitted, team, rangeMetrics] = await Promise.all([
    isToday ? eodFor(user.id, day) : null,
    eodPreflightFor(user.id, day),
    storedEodReport(user.id, day),
    isManager(user) ? teamEod(range) : Promise.resolve(null),
    isToday ? null : eodMetricsForRange(user.id, range),
  ]);

  const lines = (isToday ? report!.lines : eodLines(rangeMetrics!)).map((l) => ({
    k: l.label,
    v: l.value,
  }));

  return (
    <EodScreen
      scopeLabel={scopeLabel(scope, user)}
      period={period}
      rangeFrom={range.from}
      rangeTo={range.to}
      isManager={isManager(user)}
      lines={lines}
      message={isToday ? report!.whatsappText : null}
      // The gate: reminders due today that are still open block finalisation.
      dueReminders={preflight.blocking.map((r) => ({
        id: r.id,
        note: r.note,
        dueDate: r.dueDate,
        customerName: r.customerName,
        overdueDays: Math.max(0, daysBetween(r.dueDate, day)),
      }))}
      blockingMessage={preflight.message}
      submittedAt={
        isToday && submitted?.finalisedAt ? submitted.finalisedAt.toISOString() : null
      }
      team={(team?.rows ?? []).map((t) => ({
        name: t.userName,
        calls: t.callsAttempted,
        connected: t.callsConnected,
        missed: t.callsMissed,
        orders: t.ordersCount,
        value: t.ordersValue,
        percent: t.targetPercent,
      }))}
      teamMessage={isToday ? (team?.whatsappText ?? null) : null}
    />
  );
}
