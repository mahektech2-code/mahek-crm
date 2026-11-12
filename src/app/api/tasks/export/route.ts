import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { today } from "@/lib/recompute";
import { EXPORT_CAP, readTaskQuery, TASK_GROUPS, TASK_TABS } from "@/lib/tasks/list-query";
import { resolveScope, taskListSlice, type TaskScopeSpec } from "@/lib/tasks/list-service";
import { PRIORITY_LABEL, STATUS_LABEL, TASK_APP_LABEL, isTaskApp } from "@/lib/tasks/rules";

/**
 * A task list, as the spreadsheet a person downloads — the WHOLE filtered
 * list, not the page on the screen, up to EXPORT_CAP rows. It is written a
 * slice at a time into the response, so ten thousand rows never sit in memory
 * at once, and it ends with a line saying so where the cap cut it short.
 */
export const dynamic = "force-dynamic";

const SLICE = 1000;
const KIND: Record<string, string> = { auto: "Raised by an app", routine: "From a routine", assigned: "Given", self: "Added by themselves" };

function readSpec(raw: string | null): TaskScopeSpec | null {
  try {
    const s = JSON.parse(raw ?? "") as TaskScopeSpec;
    const apps = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is never => typeof x === "string" && isTaskApp(x)) : undefined);
    switch (s?.kind) {
      case "mine":
      case "incoming":
        return { kind: s.kind, apps: apps((s as { apps?: unknown }).apps) };
      case "outgoing":
        return { kind: "outgoing" };
      case "given":
        return { kind: "given", singles: Boolean((s as { singles?: unknown }).singles) };
      case "person":
        return typeof s.personId === "string" ? { kind: "person", personId: s.personId } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in first.", { status: 401 });
  const apps = await listUserApps(user.id);
  if (!apps.length) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const spec = readSpec(url.searchParams.get("scope"));
  const scope = spec ? await resolveScope(user, spec) : null;
  if (!scope) return new Response("Not found", { status: 404 });
  const q = readTaskQuery(Object.fromEntries(url.searchParams), { tab: "open", group: "none", tabs: TASK_TABS, groups: TASK_GROUPS });
  const day = await today();
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(["Task", "About", "App", "Where from", "Status", "Priority", "Due", "Time", "Checklist", "For", "Given by", "Closed remark"].map(cell).join(",") + "\n"));
      let written = 0;
      try {
        for (let offset = 0; offset < EXPORT_CAP; offset += SLICE) {
          const rows = await taskListSlice(scope, q, day, offset, Math.min(SLICE, EXPORT_CAP - offset));
          for (const t of rows) {
            controller.enqueue(
              enc.encode(
                [
                  t.title,
                  t.customerName ?? "",
                  t.app === "tasks" ? "Personal" : (TASK_APP_LABEL[t.app] ?? t.app),
                  KIND[t.kind] ?? t.kind,
                  STATUS_LABEL[t.status],
                  PRIORITY_LABEL[t.priority],
                  t.dueDate,
                  t.dueTime ?? "",
                  t.checklist.length ? `${t.checklist.filter((c) => c.done).length} of ${t.checklist.length}` : "",
                  t.assigneeName,
                  t.createdByName,
                  t.closeRemark ?? "",
                ]
                  .map(cell)
                  .join(",") + "\n",
              ),
            );
          }
          written += rows.length;
          if (rows.length < SLICE) break;
        }
        if (written >= EXPORT_CAP) controller.enqueue(enc.encode(cell(`Stopped at ${EXPORT_CAP.toLocaleString("en-IN")} rows — filter the list to export the rest.`) + "\n"));
      } catch (e) {
        controller.enqueue(enc.encode(cell(`The export stopped part-way: ${e instanceof Error ? e.message : "an error"}.`) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tasks-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
}
