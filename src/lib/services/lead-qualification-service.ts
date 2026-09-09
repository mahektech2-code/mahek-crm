import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  mbosTasks,
  users,
} from "@/db/schema";
import { getConfig } from "../config/store";
import { calendarDate, nextWorkingDay, type BusinessDate } from "../business-date";
import { managerNameByEmployeeName } from "./org-service";
import { MBOS_EVENT, writeTimelineEvent } from "../timeline";
import { notifyUser } from "../notify";

/* ---------------------------------------------------------------------------
 * §D and §E — what happens the moment a lead becomes a Prospect.
 *
 * Three things, in this order, and the order is the point: the seat is filled,
 * the person in it is told, and a task lands on their list. A notification
 * without a task is something that scrolls away; a task without a notification
 * is something nobody looks at until tomorrow. The brief asks for both and it
 * is right to.
 *
 * All of it is best-effort ON TOP of a completed write. `qualifyLead` is called
 * after the lead's own stage change has been committed, and nothing in here may
 * throw back into that path: a lead that failed to qualify because a push
 * notification timed out would be the worst trade in the module.
 * ------------------------------------------------------------------------- */

const gen = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * The line manager over one person, from the ORG CHART.
 *
 * The same source `recomputeSalesManagers` reads nightly for every customer,
 * asked about one person instead of all of them — so the Lead Manager a
 * qualification assigns and the sales manager the nightly pass writes cannot
 * disagree about who somebody reports to.
 *
 * It resolves by NAME, because nothing links an `employees` row to a `users`
 * row: HR maintains the workbook and MahekOne maintains the accounts, and the
 * two were never joined. A manager with no MahekOne account resolves to null
 * here rather than to a name — unlike `sales_manager_person_name`, this seat
 * has to be somebody who can open the lead and make the call.
 */
export async function lineManagerFor(userId: string): Promise<string | null> {
  const [person] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!person?.name) return null;

  const managerNameOf = await managerNameByEmployeeName();
  const managerName = managerNameOf.get(person.name.trim().toLowerCase());
  if (!managerName) return null;

  const [manager] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.name, managerName), eq(users.active, true)))
    .limit(1);

  return manager?.id ?? null;
}

/**
 * One person, told.
 *
 * Through `notifyUser`, which writes the row AND sends the push — this used to
 * do both by hand, and main has since made that one function with delivery
 * receipts behind it. A second copy would have gone on sending pushes nothing
 * tracked.
 *
 * `mbosHref` is separate from `href` on purpose: the bell in MahekOne and a tap
 * on a handset open different sets of screens, and `/sales/leads` is a page a
 * field salesman has no app to open.
 */
async function tell(
  userId: string,
  title: string,
  body: string,
  href?: string,
  mbosHref?: string,
) {
  await notifyUser({
    userId,
    title,
    body,
    href: href ?? null,
    mbosHref: mbosHref ?? null,
  }).catch(() => {});
}

export type QualifyOutcome = {
  leadManagerId: string | null;
  taskId: string | null;
  /** Null where the seat was already filled — see `alreadySeated`. */
  assigned: boolean;
};

/**
 * A lead has just become a Prospect. Fill the seat, tell them, raise the call.
 *
 * IDEMPOTENT, because a sync endpoint retries: a handset that never saw the
 * response sends the same qualification again, and a second pass must not
 * produce a second validation task on somebody's list. The guard is the seat
 * itself — if `lead_manager_id` is already set, this has run.
 *
 * A DECIDED seat is left alone. `lead_manager_decided_at` means a person chose
 * who runs this lead, and the org chart does not get to overrule that any more
 * than the sheet gets to overrule a reassignment.
 */
export async function qualifyLead(
  customerId: string,
  salesmanId: string,
  customerName: string,
): Promise<QualifyOutcome> {
  const [lead] = await db
    .select({
      leadManagerId: customers.leadManagerId,
      decidedAt: customers.leadManagerDecidedAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  /* Already seated — by a previous pass of this, or by a person. Either way
     there is nothing to assign and nobody new to tell. */
  if (!lead || lead.leadManagerId) {
    return { leadManagerId: lead?.leadManagerId ?? null, taskId: null, assigned: false };
  }

  const leadManagerId = await lineManagerFor(salesmanId);
  if (!leadManagerId) {
    /*
     * NOBODY ON THE ORG CHART, and that is said out loud rather than silently
     * skipped. A qualified lead with no Lead Manager is work with no owner, and
     * the person best placed to notice is whoever the salesman reports to in
     * MahekOne itself — which is a different question the account can answer.
     */
    const [salesman] = await db
      .select({ reportsToId: users.reportsToId, name: users.name })
      .from(users)
      .where(eq(users.id, salesmanId))
      .limit(1);
    if (salesman?.reportsToId) {
      await tell(
        salesman.reportsToId,
        "A Prospect has no Lead Manager",
        `${salesman.name} qualified ${customerName}, and the org chart names nobody above them. Assign somebody to run it, or it sits.`,
        "/sales/leads",
        "/leads",
      );
    }
    return { leadManagerId: null, taskId: null, assigned: false };
  }

  await db
    .update(customers)
    .set({
      leadManagerId,
      /*
       * NOT `leadManagerDecidedAt`. Nobody decided this — the org chart did,
       * and stamping it would freeze the seat against every future org change
       * as a side effect of a lead being qualified. The mark is for a person's
       * own pick, exactly as it is on the sales manager seat next door.
       */
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, customerId), isNull(customers.leadManagerId)));

  /* §R — work moving onto somebody's plate is a fact about the account, not
     just about the person. A history that shows a lead qualified and never
     shows who picked it up cannot answer "who was running this in March". */
  await writeTimelineEvent(db, {
    customerId,
    eventType: MBOS_EVENT.leadAssigned,
    sourceApp: "mbos",
    sourceRecordId: `${customerId}:lead_manager`,
    occurredAt: new Date(),
    actorUserId: leadManagerId,
    summary: "Qualified — a Lead Manager is now running it",
  }).catch(() => {});

  const taskId = await raiseValidationTask(customerId, leadManagerId, customerName);

  await tell(
    leadManagerId,
    "You are running a new Prospect",
    `${customerName} was qualified in the field and is yours to convert. There is a validation call on your list for the next working day.`,
    "/sales/leads",
    "/tasks",
  );

  return { leadManagerId, taskId, assigned: true };
}

/**
 * The validation call, due the NEXT WORKING DAY.
 *
 * Working days, never dates — §E says "next working day" and a task landing on
 * a Sunday is a task that is already overdue when somebody first sees it. The
 * holidays and the working week are the same configuration the salesman's
 * forecast reads, so a task and a target cannot disagree about what a working
 * day is.
 */
async function raiseValidationTask(
  customerId: string,
  assigneeId: string,
  customerName: string,
): Promise<string> {
  const config = await getConfig();
  const holidays = await db.query.mbosHolidays
    .findMany()
    .catch(() => [] as { onDate: string }[]);

  /*
   * `calendarDate`, not `toISOString().slice(0, 10)`.
   *
   * That spelling answers in UTC, so a lead qualified at 2am IST would compute
   * its "next working day" from yesterday — and it is wrong on every machine
   * equally, which is exactly why it never reads as a timezone bug. The §11
   * grep test caught it, which is what that test is for.
   */
  const today = calendarDate(new Date()) as BusinessDate;
  let due = nextWorkingDay(today, {
    timezone: config["workingDay.timezone"],
    dayBoundaryHour: config["workingDay.dayBoundaryHour"],
    workingDays: config["workingDay.workingDays"],
  });
  /* A declared holiday is not a working day either. Skipped after the weekday
     rule rather than folded into it, because the two lists come from different
     places and a holiday on a Sunday must not push the task twice. */
  const off = new Set(holidays.map((h) => String(h.onDate)));
  for (let i = 0; i < 14 && off.has(due); i++) {
    due = nextWorkingDay(due, {
      timezone: config["workingDay.timezone"],
      dayBoundaryHour: config["workingDay.dayBoundaryHour"],
      workingDays: config["workingDay.workingDays"],
    });
  }

  const id = gen("mbos_task");
  await db
    .insert(mbosTasks)
    .values({
      id,
      title: `Validation call — ${customerName}`,
      description:
        "Check what the shop says against what the salesman reported: the product explanation, the quality, dispatch and service, and how the visit went. Confirm the requirement and the monthly volume in their own words.",
      assignedToUserId: assigneeId,
      priority: "high",
      dueDate: due,
      customerId,
      status: "open",
      /* So a second pass finds it rather than raising another — the same
         reasoning as the seat guard above, one level down. */
      sourceType: "lead_validation",
      sourceId: customerId,
      createdById: assigneeId,
      updatedById: assigneeId,
    })
    .onConflictDoNothing();

  return id;
}
