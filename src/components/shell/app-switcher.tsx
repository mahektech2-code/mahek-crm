"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { cx } from "@/components/ui/primitives";
import type { AppDefinition, AppId } from "@/lib/apps";

/**
 * The grid button in every app header.
 *
 * It switches app rather than going back to the launcher: a telecaller who
 * wants Orders wants Orders, and routing them via a page of tiles to click a
 * second time is a step that exists only because it was easier to build. The
 * launcher is still one row away for anyone who wants to see everything.
 *
 * Only rendered when the account opens more than one app — a single app is not
 * a choice, and the button would be a lie.
 *
 * Each app is drawn with a GLYPH rather than its initials. Initials were the
 * whole identity of a row, and two apps share them — Accounts and Admin
 * Console are both "AC" — so the one mark meant to tell rows apart at a glance
 * was the one that could not. A line of what the app is for sits under the
 * name, because "HRMS" and "ERP" say nothing to somebody who has not opened
 * them yet.
 */
const GLYPH: Record<AppId, string> = {
  crm: "phone",
  field: "phone",
  sales: "dashboard",
  accounts: "wallet",
  people: "people",
  reports: "chart",
  hrms: "people",
  admin: "settings",
  founder: "target",
  enquiries: "mail",
  erp: "clipboard",
};

export function AppSwitcher({
  apps,
  current,
}: {
  apps: AppDefinition[];
  current: AppId;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLElement | null)[]>([]);

  React.useEffect(() => {
    if (!open) return;

    // Focus lands on the app you are in, so the arrows start from "here".
    const start = Math.max(
      0,
      apps.findIndex((a) => a.id === current),
    );
    itemRefs.current[start]?.focus();

    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      // While the menu is open the number on each tile opens it, which is
      // the same key that opens it on the launcher.
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const app = apps[Number(e.key) - 1];
        if (!app) return;
        e.preventDefault();
        setOpen(false);
        if (app.id !== current) router.push(app.href);
        return;
      }
      // Arrows walk the grid: along a row, or down and up by a whole row —
      // two tiles wide on a desk, one on a narrow window.
      const arrow = ARROW_STEP[e.key];
      if (!arrow) return;
      const columns = gridRef.current
        ? getComputedStyle(gridRef.current).gridTemplateColumns.split(" ").length
        : 1;
      const step = arrow.vertical ? arrow.by * columns : arrow.by;
      const at = itemRefs.current.findIndex(
        (el) => el === document.activeElement,
      );
      const next = at === -1 ? 0 : at + step;
      if (next < 0 || next >= apps.length) return;
      e.preventDefault();
      itemRefs.current[next]?.focus();
    };

    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, apps, current, router]);

  return (
    <div ref={boxRef} className="relative flex-none">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Switch app"
        aria-label="Switch app"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cx(
          "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border transition-colors duration-100",
          open
            ? "border-brand bg-brand-soft text-brand"
            : "border-line bg-surface text-muted hover:bg-canvas hover:text-body",
        )}
      >
        <Icon name="grid" size={16} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Switch app"
          className="animate-fade-in absolute top-10 left-0 z-50 w-[min(620px,calc(100vw-24px))] overflow-hidden rounded-[8px] border border-line bg-surface shadow-[0_12px_32px_rgba(22,22,22,0.14),0_2px_6px_rgba(22,22,22,0.06)]"
        >
          <div className="flex items-baseline justify-between gap-4 px-4 pt-3.5 pb-2">
            <span className="text-sm font-semibold text-ink">
              Switch app
            </span>
            {apps.length > 1 ? (
              <span className="hidden items-center gap-1 text-xs text-muted sm:flex">
                Press
                <Key>1</Key>–<Key>{String(Math.min(apps.length, 9))}</Key>
                to jump
              </span>
            ) : null}
          </div>

          <div
            ref={gridRef}
            className="grid grid-cols-1 gap-1 px-2 pb-2 sm:grid-cols-2"
          >
            {apps.map((app, i) => {
              const here = app.id === current;
              const tile = (
                <>
                  <span
                    className={cx(
                      "flex h-9 w-9 flex-none items-center justify-center rounded-[6px] transition-colors duration-100",
                      here
                        ? "bg-brand text-white"
                        : "bg-brand-soft text-brand group-hover:bg-brand group-hover:text-white group-focus-visible:bg-brand group-focus-visible:text-white",
                    )}
                  >
                    <Icon name={GLYPH[app.id]} size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-ink">
                        {app.name}
                      </span>
                      {!here && !app.built ? (
                        <span className="flex-none rounded-[10px] bg-divider px-1.5 text-[10px] leading-4 font-medium text-muted">
                          Not built yet
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-xs leading-[17px] text-muted">
                      {app.description}
                    </span>
                  </span>
                  {here ? (
                    <span
                      title="You are here"
                      className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand text-white"
                    >
                      <Icon name="check" size={12} strokeWidth={2.5} />
                      <span className="sr-only">You are here</span>
                    </span>
                  ) : i < 9 ? (
                    <Key>{String(i + 1)}</Key>
                  ) : null}
                </>
              );

              const shape =
                "group flex items-start gap-3 rounded-[6px] px-2.5 py-2.5 text-left no-underline outline-none hover:no-underline";
              const setRef = (el: HTMLElement | null) => {
                itemRefs.current[i] = el;
              };

              return here ? (
                <button
                  key={app.id}
                  ref={setRef}
                  type="button"
                  role="menuitem"
                  aria-current="page"
                  onClick={() => setOpen(false)}
                  className={cx(
                    shape,
                    "cursor-default bg-brand-soft ring-1 ring-brand-softer focus-visible:ring-brand",
                  )}
                >
                  {tile}
                </button>
              ) : (
                <Link
                  key={app.id}
                  ref={setRef}
                  href={app.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={cx(
                    shape,
                    "hover:bg-canvas focus-visible:bg-canvas focus-visible:ring-1 focus-visible:ring-brand",
                  )}
                >
                  {tile}
                </Link>
              );
            })}
          </div>

          <Link
            href="/apps"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="group flex items-center justify-between gap-3 border-t border-divider bg-canvas px-4 py-2.5 text-[13px] text-muted no-underline hover:text-body hover:no-underline"
          >
            All apps, and what is waiting in each
            <span className="flex items-center gap-1 font-medium text-brand">
              Open launcher
              <Icon
                name="arrowRight"
                size={14}
                className="transition-transform duration-100 group-hover:translate-x-0.5"
              />
            </span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}

const ARROW_STEP: Record<string, { by: number; vertical: boolean }> = {
  ArrowRight: { by: 1, vertical: false },
  ArrowLeft: { by: -1, vertical: false },
  ArrowDown: { by: 1, vertical: true },
  ArrowUp: { by: -1, vertical: true },
};

function Key({ children }: { children: string }) {
  return (
    <kbd className="flex h-5 min-w-5 flex-none items-center justify-center rounded-[4px] border border-line bg-surface px-1 font-sans text-[11px] font-medium text-muted">
      {children}
    </kbd>
  );
}
