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
 */
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

  React.useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      // While the menu is open the number beside each row opens it, which is
      // the same key that opens it on the launcher.
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const app = apps[Number(e.key) - 1];
        if (!app) return;
        e.preventDefault();
        setOpen(false);
        if (app.id !== current) router.push(app.href);
      }
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
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Switch app"
        aria-label="Switch app"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cx(
          "flex h-8 w-8 cursor-pointer items-center justify-center rounded-[4px] border border-line",
          open
            ? "border-brand bg-brand-soft text-brand"
            : "bg-surface text-muted hover:bg-canvas hover:text-body",
        )}
      >
        <Icon name="grid" size={16} />
      </button>

      {open ? (
        <div
          role="menu"
          className="animate-fade-in absolute top-9.5 left-0 z-50 w-[320px] rounded-[6px] border border-line bg-surface shadow-[0_4px_16px_rgba(22,22,22,0.10)]"
        >
          <div className="border-b border-divider px-3.5 py-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Switch app
          </div>

          <div className="py-1">
            {apps.map((app, i) => {
              const here = app.id === current;
              const row = (
                <>
                  <span
                    className={cx(
                      "flex h-7 w-7 flex-none items-center justify-center rounded-[4px] text-[11px] font-semibold",
                      app.tone === "primary"
                        ? "bg-brand text-white"
                        : "bg-divider text-body",
                    )}
                  >
                    {app.initials}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cx(
                        "block truncate text-sm",
                        here ? "font-medium text-ink" : "text-body",
                      )}
                    >
                      {app.name}
                    </span>
                    {here || !app.built ? (
                      <span className="block text-[11px] text-muted">
                        {here ? "You are here" : "Not built yet"}
                      </span>
                    ) : null}
                  </span>
                  <kbd className="flex h-5 w-5 flex-none items-center justify-center rounded-[4px] border border-line font-sans text-[11px] font-medium text-muted">
                    {i + 1}
                  </kbd>
                </>
              );

              return here ? (
                <span
                  key={app.id}
                  role="menuitem"
                  aria-current="page"
                  className="flex items-center gap-2.5 bg-brand-soft/60 px-3.5 py-2"
                >
                  {row}
                </span>
              ) : (
                <Link
                  key={app.id}
                  href={app.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 px-3.5 py-2 no-underline hover:bg-canvas hover:no-underline"
                >
                  {row}
                </Link>
              );
            })}
          </div>

          <Link
            href="/apps"
            onClick={() => setOpen(false)}
            className="flex items-center justify-between border-t border-divider px-3.5 py-2.5 text-[13px] text-muted no-underline hover:bg-canvas hover:text-body hover:no-underline"
          >
            See all apps and what is waiting
            <span className="text-brand">→</span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}
