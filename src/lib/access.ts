import "server-only";
import { cache } from "react";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  attendance,
  complaints,
  customers,
  queueItems,
  reminders,
  type User,
} from "@/db/schema";
import { APPS, type AppDefinition, type AppId } from "./apps";
import { isManager } from "./auth";
import { today } from "./format";

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
  const day = today();
  const teamWide = isManager(user);

  const out: LauncherApp[] = [];

  for (const app of APPS.filter((a) => ids.includes(a.id))) {
    if (app.id !== "crm") {
      out.push({
        ...app,
        count: 0,
        status: app.built ? "Nothing waiting" : "Not built yet",
      });
      continue;
    }

    const [dueReminders, queueLeft, openComplaints] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(reminders)
        .where(
          and(
            eq(reminders.status, "open"),
            lte(reminders.dueDate, day),
            teamWide ? undefined : eq(reminders.userId, user.id),
          ),
        )
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(queueItems)
        .where(
          and(
            eq(queueItems.day, day),
            eq(queueItems.worked, false),
            eq(queueItems.skipped, false),
            teamWide ? undefined : eq(queueItems.ownerId, user.id),
          ),
        )
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(complaints)
        .innerJoin(customers, eq(customers.id, complaints.customerId))
        .where(
          and(
            inArray(complaints.status, ["Open", "In progress"]),
            teamWide ? undefined : eq(customers.ownerId, user.id),
          ),
        )
        .then((r) => r[0]?.n ?? 0),
    ]);

    // The badge counts the same thing the sentence describes — a tile that says
    // "17 still to call" must not wear a badge reading 26.
    const [count, status] = queueLeft
      ? ([
          queueLeft,
          teamWide
            ? `${queueLeft} still to call across the team`
            : `${queueLeft} in your queue today`,
        ] as const)
      : dueReminders
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
    .values({ id, userId, day: today(), signedInAt: new Date() })
    .onConflictDoUpdate({
      target: [attendance.userId, attendance.day],
      set: { signedOutAt: null },
    });
}

export async function recordSignOut(userId: string) {
  await db
    .update(attendance)
    .set({ signedOutAt: new Date() })
    .where(and(eq(attendance.userId, userId), eq(attendance.day, today())));
}

export async function todaysAttendance(userId: string) {
  const rows = await db
    .select()
    .from(attendance)
    .where(and(eq(attendance.userId, userId), eq(attendance.day, today())))
    .limit(1);
  return rows[0] ?? null;
}
