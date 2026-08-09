import "server-only";
import { cache } from "react";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  attendance,
  complaints,
  customers,
  reminders,
  type User,
} from "@/db/schema";
import { APPS, type AppDefinition, type AppId } from "./apps";
import { isManager } from "./auth";
// The business day, not the calendar day — a 4am sign-in belongs to the shift
// that started yesterday, and the boundary is configurable.
import { today } from "./recompute";
import { pendingOrderCount } from "./services/order-approval-service";
import { activeEmployeeCount } from "./services/employee-service";

/* ---------------------------------------------------------------------------
 * Who can open what, and what is waiting for them inside it.
 * ------------------------------------------------------------------------- */

export const listUserApps = cache(async function listUserApps(
  userId: string,
): Promise<AppId[]> {
  const rows = await db
    .select({ app: appAccess.app })
    .from(appAccess)
    .where(eq(appAccess.userId, userId));

  const granted = new Set(rows.map((r) => r.app));
  // Keep the registry's order so the launcher grid is stable between users.
  return APPS.filter((a) => granted.has(a.id)).map((a) => a.id);
});

export async function canOpen(userId: string, app: AppId): Promise<boolean> {
  const rows = await db
    .select({ id: appAccess.id })
    .from(appAccess)
    .where(and(eq(appAccess.userId, userId), eq(appAccess.app, app)))
    .limit(1);
  return rows.length > 0;
}

export type LauncherApp = AppDefinition & {
  /** How many things are waiting — drives the red pill on the card. */
  count: number;
  /** One sentence about the state of that app for this person. */
  status: string;
};

/**
 * The counts on the launcher cards are the same numbers the apps themselves
 * show, so opening an app never contradicts the tile you clicked.
 */
export async function launcherApps(user: User): Promise<LauncherApp[]> {
  const ids = await listUserApps(user.id);
  const day = await today();
  const teamWide = isManager(user);

  const out: LauncherApp[] = [];

  for (const app of APPS.filter((a) => ids.includes(a.id))) {
    // Orders waiting on accounts are the only thing that app holds today, and
    // an order nobody has looked at is a customer nobody has confirmed to.
    if (app.id === "orders") {
      const waiting = await pendingOrderCount();
      out.push({
        ...app,
        count: waiting,
        status: waiting
          ? `${waiting} order${waiting === 1 ? "" : "s"} waiting for approval`
          : "Nothing waiting",
      });
      continue;
    }

    // The employee master has nothing waiting in it — it is a record, not a
    // worklist — so the tile says how many people are on the books. The badge
    // stays at zero deliberately: a headcount is not a task, and a red pill
    // over it would read as seventy things somebody has to do.
    if (app.id === "hrms") {
      const headcount = await activeEmployeeCount();
      out.push({
        ...app,
        count: 0,
        status: headcount
          ? `${headcount} active employee${headcount === 1 ? "" : "s"}`
          : "No employees imported yet",
      });
      continue;
    }

    if (app.id !== "crm") {
      out.push({
        ...app,
        count: 0,
        status: app.built ? "Nothing waiting" : "Not built yet",
      });
      continue;
    }

    // The queue is computed on request, so the launcher counts the durable
    // things waiting rather than rebuilding a whole queue for a tile.
    const [dueReminders, openComplaints] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(reminders)
        .where(
          and(
            eq(reminders.status, "pending"),
            lte(reminders.dueDate, day),
            teamWide ? undefined : eq(reminders.assignedUserId, user.id),
          ),
        )
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(complaints)
        .innerJoin(customers, eq(customers.id, complaints.customerId))
        .where(
          and(
            inArray(complaints.status, ["open", "in_progress", "awaiting_customer"]),
            teamWide ? undefined : eq(customers.ownerId, user.id),
          ),
        )
        .then((r) => r[0]?.n ?? 0),
    ]);

    // The badge counts the same thing the sentence describes.
    const [count, status] = dueReminders
      ? ([
          dueReminders,
          `${dueReminders} reminder${dueReminders === 1 ? "" : "s"} due`,
        ] as const)
      : openComplaints
        ? ([
            openComplaints,
            `${openComplaints} complaint${openComplaints === 1 ? "" : "s"} open`,
          ] as const)
        : ([0, "Nothing waiting"] as const);

    out.push({ ...app, count, status });
  }

  return out;
}

export function lockedApps(ids: AppId[]): AppDefinition[] {
  return APPS.filter((a) => !ids.includes(a.id));
}

/* ------------------------------------------------------------- attendance */

/**
 * Signing in opens the day. A second sign-in on the same day reopens the same
 * row rather than starting a new one, so a lunch break does not read as two
 * shifts.
 */
export async function recordSignIn(userId: string, id: string) {
  await db
    .insert(attendance)
    .values({ id, userId, day: await today(), signedInAt: new Date() })
    .onConflictDoUpdate({
      target: [attendance.userId, attendance.day],
      set: { signedOutAt: null },
    });
}

export async function recordSignOut(userId: string) {
  await db
    .update(attendance)
    .set({ signedOutAt: new Date() })
    .where(and(eq(attendance.userId, userId), eq(attendance.day, await today())));
}

export async function todaysAttendance(userId: string) {
  const rows = await db
    .select()
    .from(attendance)
    .where(and(eq(attendance.userId, userId), eq(attendance.day, await today())))
    .limit(1);
  return rows[0] ?? null;
}
