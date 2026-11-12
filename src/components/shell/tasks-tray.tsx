"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { loadTray, type Tray } from "@/lib/actions/task-tray";
import { TASK_APP_LABEL, clock12, dueWords, taskLink, isTaskApp, APP_TASKS_PATH } from "@/lib/tasks/rules";

/**
 * MY TASKS IN EVERY APP — the ✓ in each app's header, beside the bell. A count
 * of everything open, and the next six, soonest first, wherever they are; a
 * row opens the task where its work is (TeleCRM's own My tasks for CRM work).
 * Drawn only for somebody who holds Tasks or has a task: for anybody else it
 * would be a button that opens nothing.
 */
export function TasksTray() {
  const pathname = usePathname();
  const [tray, setTray] = React.useState<Tray | null>(null);
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const refresh = React.useCallback(() => {
    void loadTray()
      .then((r) => r.ok && setTray(r.data))
      .catch(() => undefined);
  }, []);
  React.useEffect(() => {
    refresh();
  }, [refresh, pathname]);
  React.useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!tray || (!tray.holdsTasks && !tray.open)) return null;
  /* The app this header belongs to, read off the address, and its own My tasks. */
  const seg = pathname.split("/")[1] ?? "";
  const here = isTaskApp(seg) && APP_TASKS_PATH[seg] ? { app: seg, path: APP_TASKS_PATH[seg]! } : null;
  const href = (t: Tray["next"][number]) => taskLink(t, { tasks: tray.holdsTasks, apps: tray.apps });

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`My tasks in every app — ${tray.open} open`}
        title="My tasks in every app"
        aria-expanded={open}
        onClick={() => {
          if (!open) refresh();
          setOpen((o) => !o);
        }}
        className="relative inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-[7px] border-0 bg-transparent text-[#5a4e8c] hover:bg-[#e4dbff] hover:text-[#1e1446]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M22 11.1V12a10 10 0 1 1-5.9-9.1" />
          <path d="M22 4 12 14l-3-3" />
        </svg>
        {tray.open ? (
          <span className={cx("absolute -top-[3px] -right-1 min-w-[17px] rounded-full px-[5px] text-center text-[10.5px] leading-[17px] font-bold text-white", tray.late ? "bg-danger" : "bg-brand")}>
            {tray.open > 99 ? "99+" : tray.open}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute top-10 right-0 z-50 w-[min(400px,calc(100vw-24px))] rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_12px_32px_rgba(15,27,51,.16)]">
          <div className="px-2.5 pt-2 pb-1 text-xs font-semibold text-muted">Next up, in every app</div>
          {tray.next.length ? (
            tray.next.map((t) => (
              <Link
                key={t.id}
                href={href(t)}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[13.5px] text-ink no-underline hover:bg-[#f1f4f9] hover:no-underline"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {t.app === "tasks" ? "Personal" : TASK_APP_LABEL[t.app]}
                    {t.customerName ? ` · ${t.customerName}` : ""}
                  </span>
                </span>
                <span className={cx("text-[12.5px] font-semibold whitespace-nowrap", t.dueDate < tray.today ? "text-danger" : t.dueDate === tray.today ? "text-brand-hover" : "text-body")}>
                  {dueWords(t.dueDate, tray.today)}
                  {t.dueTime && t.dueDate >= tray.today ? ` · ${clock12(t.dueTime)}` : ""}
                </span>
              </Link>
            ))
          ) : (
            <div className="px-2.5 py-3 text-sm text-muted">Nothing open. Well done.</div>
          )}
          {here && tray.apps.includes(here.app) ? (
            <>
              <div className="mx-1 my-1.5 h-px bg-divider" />
              <Link href={here.path} onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-[7px] px-2.5 py-2 text-[13.5px] font-semibold text-brand no-underline hover:bg-[#f1f4f9] hover:no-underline">
                My tasks in {TASK_APP_LABEL[here.app]}
              </Link>
            </>
          ) : null}
          {tray.holdsTasks ? (
            <>
              <div className="mx-1 my-1.5 h-px bg-divider" />
              <Link href="/tasks" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-[7px] px-2.5 py-2 text-[13.5px] font-semibold text-brand no-underline hover:bg-[#f1f4f9] hover:no-underline">
                Open My day in Tasks
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
