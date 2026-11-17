import "server-only";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, taskEvents } from "@/db/schema";
import { APP_TIMEZONE } from "@/lib/business-date";
import { notifyUser } from "@/lib/notify";
import { MISSED_FROM, clock12, taskLink } from "./rules";
import { routineDeadlineSql, routineGraceMinutes } from "./service";

/* ---------------------------------------------------------------------------
 * THE GRACE-TIME ALERT. When one of somebody's routine tasks passes its due
 * time it has grace time before it is missed (rules.ts); this tells them, once
 * per task, as a notification that pops up in whatever MahekOne tab they have
 * open and stays in the bell.
 *
 * It rides the bell's own poll (`/api/notifications`, every few seconds from
 * every tab) instead of a job, because jobs run hourly and the whole window
 * is fifteen minutes. So it is held to one cheap indexed read per person per
 * half-minute, and a task is alerted at most once: a `grace` event on the task
 * is the record, taken under a lock on the task so two tabs polling in the
 * same instant cannot both send it.
 * ------------------------------------------------------------------------- */

const EVERY_MS = 30_000;
const lastLook = new Map<string, number>();

/** "5:15 PM" — when it will be missed, read in India. */
function clockOf(at: Date): string {
  return clock12(at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: APP_TIMEZONE }));
}

export async function alertGraceTasks(userId: string): Promise<number> {
  const now = Date.now();
  if ((lastLook.get(userId) ?? 0) > now - EVERY_MS) return 0;
  lastLook.set(userId, now);
  if (lastLook.size > 5000) lastLook.clear();

  const grace = await routineGraceMinutes();
  if (!grace) return 0;
  const until = sql`${routineDeadlineSql} + make_interval(mins => ${grace})`;
  const due = (await db.execute(sql`
    select t.id, t.title, t.app, ${until} as until
      from tasks t
     where t.assignee_id = ${userId}
       and t.routine_id is not null and t.status <> 'done' and t.status <> 'missed'
       and t.due_date >= ${MISSED_FROM}::date
       and t.due_date >= (now() at time zone ${APP_TIMEZONE})::date - 1
       and t.due_date <= (now() at time zone ${APP_TIMEZONE})::date
       and ${routineDeadlineSql} <= now() and ${until} > now()
       and not exists (select 1 from task_events e where e.task_id = t.id and e.kind = 'grace')
  `)) as unknown as { id: string; title: string; app: string; until: string | Date }[];
  if (!due.length) return 0;

  const apps = (await db.select({ app: appAccess.app }).from(appAccess).where(eq(appAccess.userId, userId))).map((r) => String(r.app));
  let sent = 0;
  for (const t of due) {
    const at = new Date(t.until);
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`grace:${t.id}`}))`);
      const seen = await tx.execute(sql`select 1 from task_events where task_id = ${t.id} and kind = 'grace' limit 1`);
      if ((seen as unknown as unknown[]).length) return false;
      await tx.insert(taskEvents).values({
        id: `tev_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        taskId: t.id,
        actorId: null,
        kind: "grace",
        body: `Past its due time — grace time until ${clockOf(at)}.`,
      });
      return true;
    });
    if (!claimed) continue;
    await notifyUser({
      userId,
      title: `Grace time: ${t.title}`,
      body: `Past its due time. Do it by ${clockOf(at)} or it will be missed.`,
      kind: "warn",
      general: true,
      href: taskLink({ id: t.id, app: t.app }, { tasks: apps.includes("tasks"), apps }),
    }).catch(() => undefined);
    sent++;
  }
  return sent;
}
