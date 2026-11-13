import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsOffices } from "@/db/schema";
import type { HrmsContext } from "@/lib/hrms/access";
import { attendanceCfg, attendanceRows } from "@/lib/hrms/services/attendance";
import { timingMap } from "@/lib/hrms/services/people";
import { timeRemark } from "@/lib/hrms/engines/attendance";
import { today } from "@/lib/hrms/server";
import { weekdayOf, hm, distanceLabel, tmin } from "@/lib/hrms/time";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import type { CheckInState } from "@/components/checkin/check-in-panel";

/**
 * TODAY'S CHECK-IN, as the launcher's check-in draws it. Checking in left the
 * HRMS for the MahekOne launcher (Nov 2026), so this is read by the launcher
 * and, to say whether somebody has checked in, by the HRMS Home — one reading
 * of one day, so the two cannot disagree.
 */
export async function checkInState(ctx: HrmsContext): Promise<CheckInState> {
  const t = today();
  const me = ctx.employee;
  const cfg = await attendanceCfg();
  const config = await getConfig();
  const base: CheckInState = { linked: false, name: ctx.user.name, date: t, qr: config["hrms.attendance.qrEnabled"], graceMinutes: cfg.graceMinutes, nowMs: nowMs() };
  if (!me) return base;
  const [rows, timings, office] = await Promise.all([
    attendanceRows({ employeeIds: [me.id], from: t, to: t }),
    timingMap(),
    me.office ? db.select().from(hrmsOffices).where(eq(hrmsOffices.name, me.office)).limit(1) : Promise.resolve([]),
  ]);
  const tm = timings.get(`${me.id}|${weekdayOf(t)}`);
  const r = rows[0];
  return {
    ...base,
    linked: true,
    name: me.name,
    office: me.office ?? "",
    officeHasPin: office[0]?.lat != null,
    official: tm ? `${tm.inTime} – ${tm.outTime}` : "",
    today: r
      ? {
          in: r.checkIn,
          out: r.checkOut,
          status: r.fig.current,
          late: r.fig.lateTxt,
          lateBad: r.fig.lateBeyondGrace || (r.fig.lateMin ?? 0) > 0,
          remark: timeRemark(r.fig, me.name, r.method),
          targetMin: r.targetMin,
          inMin: tmin(r.checkIn),
          workedMin: r.fig.workedMin,
          workDay: r.fig.workDay,
          fullDayPercent: cfg.fullDayPercent,
          distance: r.method === "officer" ? `Marked by ${r.markedByName ?? "your department head"}` : distanceLabel(r.distanceM),
          worked: hm(r.fig.workedMin),
          field: r.method === "field",
        }
      : null,
  };
}
