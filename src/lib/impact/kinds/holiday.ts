import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsHolidays, mbosHolidayAssignments, mbosHolidayMembers, mbosHolidays, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { longDate } from "@/lib/format";
import { today } from "@/lib/recompute";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * A HOLIDAY lives in two calendars and on every phone that pulled it.
 *
 * HRMS's calendar is the master (payroll and the absentee list read it); a
 * holiday for everybody is also a row of the field calendar under the same
 * id, which the handset, the field attendance verdict and the sales forecast
 * read. `removeEverywhere` deletes both and tombstones the phones — this says
 * so before it happens, with the people it was a day off for by name.
 * ------------------------------------------------------------------------- */

export const holidayImpact: ImpactSource = {
  /* Names and dates, nothing private: anybody signed in may read the report.
     The act itself still asks for the HRMS administrator or the Sales
     Dashboard manager, as it always has. */
  authorize: async () => {
    await requireUser();
  },

  async report(id) {
    const [[hr], [field]] = await Promise.all([
      db.select().from(hrmsHolidays).where(eq(hrmsHolidays.id, id)).limit(1),
      db.select().from(mbosHolidays).where(eq(mbosHolidays.id, id)).limit(1),
    ]);
    if (!hr && !field) return null;

    const name = hr?.name ?? field!.name;
    const onDate = String(hr?.date ?? field!.onDate);
    const [members, assignments, day] = await Promise.all([
      db
        .select({ name: users.name })
        .from(mbosHolidayMembers)
        .innerJoin(users, eq(users.id, mbosHolidayMembers.userId))
        .where(eq(mbosHolidayMembers.holidayId, id))
        .orderBy(asc(users.name)),
      db
        .select({ name: users.name, mode: mbosHolidayAssignments.mode })
        .from(mbosHolidayAssignments)
        .innerJoin(users, eq(users.id, mbosHolidayAssignments.userId))
        .where(eq(mbosHolidayAssignments.holidayId, id)),
      today(),
    ]);
    const passed = onDate < day;

    const items: ImpactItem[] = [];
    if (hr) {
      items.push({
        app: "HRMS",
        label: "holiday on the HRMS calendar",
        effect: "deleted",
        count: 1,
        note:
          `It is for ${hr.tagged === "All employees" ? "all employees" : hr.tagged}. ` +
          (passed
            ? `${longDate(onDate)} has passed: payroll and attendance will read it as a working day, so anybody who did not work it will show as absent.`
            : "Payroll and attendance will treat the day as a working day."),
      });
    }
    if (field) {
      items.push({
        app: "Sales Dashboard",
        label: "day off on the field calendar",
        effect: "deleted",
        count: 1,
        note: "The field attendance verdict and the sales forecast will count it as a working day.",
      });
    }
    items.push({
      app: "Sales Dashboard",
      label: assignments.length === 1 ? "person named on it" : "people named on it",
      effect: "deleted",
      count: assignments.length,
      examples: assignments.slice(0, 5).map((a) => `${a.name} (${a.mode === "exclude" ? "left out" : "added"})`),
    });
    items.push({
      app: "MBOS handsets",
      label: members.length === 1 ? "salesman's phone" : "salesmen's phones",
      effect: "phones",
      count: members.length,
      examples: members.slice(0, 5).map((m) => m.name),
      note: "The day comes off their calendar on the next sync and is no longer a day off for them.",
    });

    return {
      title: `${name}, ${longDate(onDate)}`,
      verb: "Remove",
      confirmWord: name,
      items,
      blockers: [],
    };
  },
};
