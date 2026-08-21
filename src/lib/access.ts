import "server-only";
import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  appAccess,
  appModuleAccess,
  attendance,
  type User,
} from "@/db/schema";
import { APPS, type AppDefinition, type AppId } from "./apps";
import {
  getModule,
  moduleAllowed,
  modulesForApp,
  type AppModule,
} from "./modules";
// The business day, not the calendar day — a 4am sign-in belongs to the shift
// that started yesterday, and the boundary is configurable.
import { today } from "./recompute";
import { pendingOrderCount } from "./services/order-approval-service";
import { crmBadgeCounts } from "./queries";
import { pendingReceiptCount } from "./services/receipt-service";
import { pendingCreditNoteCount } from "./services/credit-note-service";
import { activeEmployeeCount } from "./services/employee-service";
import { pendingApprovalCount, unplannedCount } from "./services/sales-service";
import { addDays } from "./business-date";

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

/**
 * The modules of one app this person may open, in the app's own order.
 *
 * No module rows means every module — the rule is stated once, in
 * `moduleAllowed`, and read here so a grant made from a terminal or from the
 * provisioning endpoint, neither of which knows modules exist, opens the app
 * whole rather than opening it empty.
 *
 * Cached per request: the layout asks for the sidebar, the guard asks again
 * for the route, and both are one round trip to a database in another
 * continent.
 */
export const listUserModules = cache(async function listUserModules(
  userId: string,
  app: AppId,
): Promise<AppModule[]> {
  const rows = await db
    .select({ module: appModuleAccess.module })
    .from(appModuleAccess)
    .where(and(eq(appModuleAccess.userId, userId), eq(appModuleAccess.app, app)));

  const granted = rows.map((r) => r.module);
  return modulesForApp(app).filter((m) => moduleAllowed(m.key, granted, app));
});

/**
 * The guard every app screen runs.
 *
 * It answers with a redirect rather than a message: somebody who was never
 * given Monthly Targets has no use for a page explaining that, and a bookmark
 * or a stale link is the ordinary way to arrive here. They land on the first
 * module they DO hold — or on the launcher, which says plainly when they hold
 * nothing.
 *
 * Checked on the server, on the route, not by hiding the sidebar link. A link
 * that is not drawn is a statement to the browser, and the browser is not where
 * authority lives.
 */
export async function requireModule(userId: string, key: string): Promise<void> {
  const mod = getModule(key);
  if (!mod) throw new Error(`Not a module: ${key}`);

  const allowed = await listUserModules(userId, mod.app);
  if (allowed.some((m) => m.key === key)) return;

  // Imported lazily, the same way `requireUser` does it: next/navigation pulls
  // in the client React runtime, which the integration tests cannot load
  // outside a request.
  const { redirect } = await import("next/navigation");
  redirect(allowed[0]?.href ?? "/apps");
}

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

  const out: LauncherApp[] = [];

  for (const app of APPS.filter((a) => ids.includes(a.id))) {
    /*
     * Accounts hold three queues, not one. The tile counted orders alone,
     * which was honest about its own sentence and silently wrong about the
     * app: money nobody has confirmed and credit notes nobody has decided
     * both leave somebody waiting, and neither reached the launcher.
     *
     * The badge is the total, and the sentence names what that total is made
     * of — so the number and the words still describe the same thing, which is
     * the rule the single-queue version was keeping.
     */
    if (app.id === "accounts") {
      const [orders, payments, credits] = await Promise.all([
        pendingOrderCount(),
        pendingReceiptCount(),
        pendingCreditNoteCount(),
      ]);
      const waiting = orders + payments + credits;

      const parts: string[] = [];
      if (orders) parts.push(`${orders} order${orders === 1 ? "" : "s"} to approve`);
      if (payments) {
        parts.push(`${payments} payment${payments === 1 ? "" : "s"} to confirm`);
      }
      if (credits) {
        parts.push(`${credits} credit note${credits === 1 ? "" : "s"}`);
      }

      out.push({
        ...app,
        count: waiting,
        status: parts.length ? parts.join(" · ") : "Nothing waiting",
      });
      continue;
    }

    /*
     * The Sales Dashboard holds two kinds of waiting and they are not the same
     * urgency, so the badge counts only one of them.
     *
     * An approval is somebody standing in a shop unable to move; a day nobody
     * has planned is a route that will simply be improvised. Both are said in
     * the sentence, and only the first drives the red pill — a badge that
     * counted unplanned days would sit permanently at the size of the team,
     * which is how a badge stops meaning anything.
     */
    if (app.id === "sales") {
      const day = await today();
      const [approvals, unplanned] = await Promise.all([
        pendingApprovalCount(),
        unplannedCount(addDays(day, 1)),
      ]);

      const parts: string[] = [];
      if (approvals) {
        parts.push(`${approvals} approval${approvals === 1 ? "" : "s"} waiting`);
      }
      if (unplanned) {
        parts.push(
          `${unplanned} ${unplanned === 1 ? "salesman has" : "salesmen have"} no route tomorrow`,
        );
      }

      out.push({
        ...app,
        count: approvals,
        status: parts.length ? parts.join(" · ") : "Nothing waiting",
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
    //
    // From `crmBadgeCounts`, which is also what the CRM's own sidebar reads.
    // These were two separate pairs of queries, and they disagreed: this one
    // widened to the team for any manager, while the sidebar honoured the
    // My book / Team switch. A manager on My book therefore saw one number on
    // the tile and a smaller one inside the app it opened.
    const { dueReminders, openComplaints } = await crmBadgeCounts();

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

/* ------------------------------------------------------- the sign-in log */

/**
 * When somebody opened MahekOne, and when they last closed it. Despite the
 * table's name this is NOT attendance, and no screen may present it as such.
 *
 * A sign-in says a person opened the app, not that they were at work — from
 * home, on a phone, at 2am, or not at all if they left a session open from
 * yesterday. Sign-out is worse: most people close the tab, so `signedOutAt`
 * stays null and the day never closes. Hours cannot be derived from either.
 *
 * Attendance is a check-in system with its own screens, and it is not built
 * yet. This log is a useful signal for it — and for "has this account ever
 * been used" in the console — but it is not the record.
 *
 * A second sign-in on the same day reopens the same row rather than starting
 * a new one, so a lunch break does not read as two sessions.
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
