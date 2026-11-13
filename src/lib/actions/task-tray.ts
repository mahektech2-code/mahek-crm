"use server";

import { requireReader } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { today } from "@/lib/recompute";
import { ok, type Result } from "@/lib/result";
import { trayTasks } from "@/lib/tasks/list-service";
import type { TaskApp } from "@/lib/tasks/rules";

export type TrayTask = { id: string; title: string; app: TaskApp; customerName: string | null; dueDate: string; dueTime: string | null };
export type Tray = { holdsTasks: boolean; apps: string[]; open: number; late: number; next: TrayTask[]; today: string };

/**
 * The header's tasks tray, in every app: how many tasks are open and the next
 * six, soonest first. Read when a header mounts and again when it is opened —
 * it is a pointer to the Tasks app, never a second copy of it.
 */
export async function loadTray(): Promise<Result<Tray>> {
  const user = await requireReader();
  const day = await today();
  const [apps, tray] = await Promise.all([listUserApps(user.id), trayTasks(user.id, day, 6)]);
  const next = tray.next.map((t) => ({ id: t.id, title: t.title, app: t.app, customerName: t.customerName, dueDate: t.dueDate, dueTime: t.dueTime }));
  return ok({ holdsTasks: apps.includes("tasks" as never), apps: [...apps], open: tray.open, late: tray.late, next, today: day });
}
