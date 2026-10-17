import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { hrmsHolidays, mbosDeletions, mbosHolidays } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * ONE HOLIDAY CALENDAR.
 *
 * There were two: HRMS's (`hrms_holidays` — a category, and who a holiday is
 * for: everybody, an office, named people) and the field app's
 * (`mbos_holidays` — a date, a name and a free-text scope). Payroll and the
 * absentee list read the first; the field attendance verdict, the sales
 * forecast's working days and the handset itself read the second. A festival
 * entered on one screen did not exist on the other, so a salesman's day off
 * read as a missed check-in and an office's as a working day in the forecast.
 *
 * HRMS's calendar is the master now, because it says more. A holiday for all
 * employees is also a row of the field calendar under the SAME id — that is
 * what the handset, the verdict and the forecast read, and none of them knows
 * offices or names, so a holiday for one office or named people stays in
 * HRMS. The Sales Dashboard's Holidays screen writes through here too, so a
 * day entered there is on HRMS's calendar as well. Removing one removes both,
 * and tombstones the handsets that already pulled it.
 * ------------------------------------------------------------------------- */

export const EVERYBODY = "All employees";

type Tx = Pick<typeof db, "insert" | "update" | "delete" | "select">;

/** The field calendar's copy of the HRMS holidays that are for everybody. */
export async function mirrorToField(tx: Tx, rows: { id: string; date: string; name: string; tagged: string }[], userId: string | null): Promise<void> {
  const everybody = rows.filter((r) => r.tagged === EVERYBODY);
  for (const r of everybody)
    await tx
      .insert(mbosHolidays)
      .values({ id: r.id, onDate: r.date, name: r.name, scope: null, createdById: userId, updatedById: userId })
      .onConflictDoUpdate({ target: mbosHolidays.id, set: { onDate: r.date, name: r.name, updatedById: userId, updatedAt: new Date() } });
}

/** A holiday taken off the calendar comes off the field calendar and the handsets too. */
export async function removeEverywhere(tx: Tx, id: string): Promise<void> {
  await tx.delete(hrmsHolidays).where(eq(hrmsHolidays.id, id));
  const gone = await tx.delete(mbosHolidays).where(eq(mbosHolidays.id, id)).returning({ id: mbosHolidays.id });
  if (gone.length)
    await tx.insert(mbosDeletions).values({ id: `del_${randomUUID().replace(/-/g, "").slice(0, 16)}`, entity: "holidays", entityId: id, userId: null, reason: "Holiday removed" });
}

/**
 * A day entered on the Sales Dashboard, on HRMS's calendar too. Its free-text
 * scope is kept as who it is for: an office's name applies to that office in
 * HRMS, anything else ("Nagpur East") to nobody there — HRMS has no beats.
 */
export async function mirrorToHrms(tx: Tx, row: { id: string; onDate: string; name: string; scope: string | null }, user: { id: string; name: string }): Promise<void> {
  /* HR already has the day for everybody: one entry, not two answers. */
  const [already] = await tx.select({ id: hrmsHolidays.id }).from(hrmsHolidays).where(and(eq(hrmsHolidays.date, row.onDate), eq(hrmsHolidays.tagged, row.scope ?? EVERYBODY))).limit(1);
  if (already) return;
  await tx
    .insert(hrmsHolidays)
    .values({ id: row.id, date: row.onDate, category: "Festival", name: row.name, tagged: row.scope ?? EVERYBODY, remark: "Entered on the Sales Dashboard", createdByName: user.name, createdById: user.id })
    .onConflictDoNothing();
}

/** Whether an id is on the field calendar — the edit of a name follows it there. */
export async function renameEverywhere(tx: Tx, id: string, name: string): Promise<void> {
  await tx.update(mbosHolidays).set({ name, updatedAt: new Date() }).where(inArray(mbosHolidays.id, [id]));
}
