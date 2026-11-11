"use server";

import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { today } from "@/lib/recompute";
import { ok, type Result } from "@/lib/result";
import { myTasks } from "@/lib/tasks/service";
import type { TaskApp } from "@/lib/tasks/rules";

export type TrayTask = { id: string; title: string; app: TaskApp; customerName: string | null; dueDate: string; dueTime: string | null };
export type Tray = { holdsTasks: boolean; open: number; late: number; next: TrayTask[]; today: string };

/**
 * The header's tasks tray, in every app: how many tasks are open and the next
 * six, soonest first. Read when a header mounts and again when it is opened —
 * it is a pointer to the Tasks app, never a second copy of it.
 */
export async function loadTray(): Promise<Result<Tray>> {
  const user = await requireUser();
  const [apps, tasks, day] = await Promise.all([listUserApps(user.id), myTasks(user.id), today()]);
  const open = tasks.filter((t) => t.status !== "done");
  const next = [...open]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99"))
    .slice(0, 6)
    .map((t) => ({ id: t.id, title: t.title, app: t.app, customerName: t.customerName, dueDate: t.dueDate, dueTime: t.dueTime }));
  return ok({ holdsTasks: apps.includes("tasks" as never), open: open.length, late: open.filter((t) => t.dueDate < day).length, next, today: day });
}
