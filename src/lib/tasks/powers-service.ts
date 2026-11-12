import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { taskUserPowers } from "@/db/schema";
import { isPlatformAdmin, levelInApp } from "@/lib/access-control";
import { heldTaskPowers, type TaskPower } from "./permissions";

/**
 * The Tasks permissions this person holds. A platform administrator and a
 * Tasks administrator hold all of them; everybody else holds the rows granted
 * on the Access screen. Request-memoised by user id — every task on a page
 * asks.
 */
const powersById = cache(async (userId: string, role: string): Promise<ReadonlySet<TaskPower>> => {
  const user = { id: userId, role };
  const administrator = (await isPlatformAdmin(user)) || (await levelInApp(user, "tasks")) === "admin";
  if (administrator) return heldTaskPowers({ administrator: true, rows: [] });
  const rows = await db.select({ power: taskUserPowers.power }).from(taskUserPowers).where(eq(taskUserPowers.userId, userId));
  return heldTaskPowers({ administrator: false, rows: rows.map((r) => r.power) });
});

export function taskPowersOf(user: { id: string; role: string }): Promise<ReadonlySet<TaskPower>> {
  return powersById(user.id, user.role);
}
