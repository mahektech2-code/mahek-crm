"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsOffices, hrmsOfficeTimings } from "@/db/schema";
import { err, fromThrown, okVoid, type Result } from "@/lib/result";
import { HrmsNotPermitted, requireHrmsWrite } from "@/lib/hrms/access";
import { hrmsAudit, hrmsId } from "@/lib/hrms/server";
import { updateSettings } from "@/lib/config/store";
import { tmin, WEEKDAYS } from "@/lib/hrms/time";

/* ---------------------------------------------------------------------------
 * The two editors under HRMS → Settings that the Workday Clock design draws:
 * ATTENDANCE SETTINGS and OFFICE TIMINGS. Attendance settings go through the
 * same audited settings store as the Admin Console, limited to the attendance
 * and workday keys; office timings are the office's week. Both need the HR
 * team (an HRMS administrator), or the "Working hours" power for timings.
 * ------------------------------------------------------------------------- */

/** The settings the Attendance settings page may change, and nothing else. */
const ATTENDANCE_KEYS = new Set([
  "hrms.workday.lockEnabled",
  "hrms.workday.exemptPlatformAdmins",
  "hrms.workday.idleWarnMinutes",
  "hrms.workday.idleBreakMinutes",
  "hrms.workday.idleOutMinutes",
  "hrms.workday.idleFromHour",
  "hrms.workday.breakOutMinutes",
  "hrms.workday.breakReasons",
  "hrms.attendance.presentHours",
  "hrms.attendance.halfDayHours",
  "hrms.attendance.graceMinutes",
]);

function refresh() {
  try {
    revalidatePath("/hrms", "layout");
    revalidatePath("/apps");
  } catch {
    /* outside a request */
  }
}

export async function saveAttendanceSettings(entries: Array<{ key: string; value: unknown }>): Promise<Result<undefined>> {
  try {
    const ctx = await requireHrmsWrite("attendanceRules");
    if (!ctx.administrator) return err("Only the HR team changes attendance settings.", "not_permitted");
    const bad = entries.find((e) => !ATTENDANCE_KEYS.has(e.key));
    if (bad) return err("That setting is not changed here.", "not_permitted");
    const r = await updateSettings(entries, ctx.user.id);
    if (!r.ok) return err(r.error, "validation", r.fields);
    refresh();
    return okVoid(entries.length === 1 ? "Saved. It applies at once." : `${entries.length} settings saved. They apply at once.`);
  } catch (e) {
    if (e instanceof HrmsNotPermitted) return err(e.message, "not_permitted");
    return fromThrown(e);
  }
}

export type OfficeDay = { weekday: string; working: boolean; inTime: string; outTime: string; presentMin: number | null; halfMin: number | null };

/** One office's whole week, saved at once: a day not working has no row. */
export async function saveOfficeWeek(officeId: string, days: OfficeDay[]): Promise<Result<undefined>> {
  try {
    const ctx = await requireHrmsWrite("officeTimings");
    if (!ctx.administrator && !ctx.powers.has("timings")) return err("Office timings are changed by the HR team, or somebody with the Working hours power.", "not_permitted");
    const [office] = await db.select().from(hrmsOffices).where(eq(hrmsOffices.id, officeId));
    if (!office) return err("That office no longer exists.", "not_found");
    const rows: (typeof hrmsOfficeTimings.$inferInsert)[] = [];
    for (const d of days) {
      if (!(WEEKDAYS as readonly string[]).includes(d.weekday)) return err(`${d.weekday} is not a day of the week.`);
      if (!d.working) continue;
      const a = tmin(d.inTime);
      const b = tmin(d.outTime);
      if (a == null || b == null) return err(`${d.weekday}: give the opening and closing times.`, "validation", [{ field: d.weekday, message: "Opening and closing times" }]);
      if (b <= a) return err(`${d.weekday}: the office closes before it opens.`, "validation", [{ field: d.weekday, message: "Closes before it opens" }]);
      const present = d.presentMin ?? null;
      const half = d.halfMin ?? null;
      if (present != null && (present <= 0 || present > 24 * 60)) return err(`${d.weekday}: present at must be between 0 and 24 hours.`);
      if (present != null && half != null && half >= present) return err(`${d.weekday}: half day must be less than present.`, "validation", [{ field: d.weekday, message: "Half day must be less than present" }]);
      rows.push({ id: hrmsId("hoft"), officeId, weekday: d.weekday, inTime: d.inTime, outTime: d.outTime, presentMin: present, halfMin: half, createdById: ctx.user.id, updatedById: ctx.user.id });
    }
    const before = await db.select().from(hrmsOfficeTimings).where(eq(hrmsOfficeTimings.officeId, officeId));
    await db.transaction(async (tx) => {
      await tx.delete(hrmsOfficeTimings).where(eq(hrmsOfficeTimings.officeId, officeId));
      if (rows.length) await tx.insert(hrmsOfficeTimings).values(rows);
    });
    await hrmsAudit(
      ctx,
      "hrms.office.timings",
      "hrms_offices",
      officeId,
      { week: before.map((r) => `${r.weekday} ${r.inTime}-${r.outTime}`) },
      { week: rows.map((r) => `${r.weekday} ${r.inTime}-${r.outTime}`) },
    );
    refresh();
    return okVoid(`Saved ${office.name}'s week. It applies from tomorrow.`);
  } catch (e) {
    if (e instanceof HrmsNotPermitted) return err(e.message, "not_permitted");
    return fromThrown(e);
  }
}
