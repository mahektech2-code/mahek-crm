"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AppFrame } from "@/components/shell/app-frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { NotificationBell } from "@/components/shell/notification-bell";
import { cx } from "@/components/ui/primitives";
import { ToastProvider } from "@/components/ui/toast";
import type { Notification } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";
import { hireSearch, type HireSearchHit } from "@/lib/hire/actions/search";
import type { HireNavGroup } from "@/lib/hire/roles";
import { Icon } from "./kit";

/* ---------------------------------------------------------------------------
 * Hire's shell (design brief §6): the MahekOne header with the breadcrumb to
 * the suite, a search that answers on `/`, the density toggle, and a sidebar
 * of SIX groups drawn per role — an interviewer sees Pipeline and Evaluate and
 * nothing else. Collapsible to a 64px icon rail; the choice is remembered on
 * this browser only.
 * ------------------------------------------------------------------------- */

export type NavCounts = Record<string, { n: number; over?: boolean }>;

export function HireShell({
  nav,
  counts,
  user,
  hat,
  notifications,
  apps,
  aiDown,
  children,
}: {
  nav: HireNavGroup[];
  counts: NavCounts;
  user: { name: string; email: string | null; phone: string | null; initials: string; role: string };
  hat: { label: string; sentence: string };
  notifications: Notification[];
  apps: AppDefinition[];
  aiDown: string | null;
  children: React.ReactNode;
}) {
  const [rail, setRail] = useState(true);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const pathname = usePathname();

  useEffect(() => {
    try {
      const r = localStorage.getItem("hire.rail");
      const d = localStorage.getItem("hire.density");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a per-browser preference read once after mount
      if (r === "0") setRail(false);
      if (d === "compact") setDensity("compact");
    } catch {}
  }, []);

  const toggleRail = () => {
    const v = !rail;
    setRail(v);
    try {
      localStorage.setItem("hire.rail", v ? "1" : "0");
    } catch {}
  };
  const pickDensity = (d: "comfortable" | "compact") => {
    setDensity(d);
    try {
      localStorage.setItem("hire.density", d);
    } catch {}
  };

  const isActive = (href: string) => (href === "/hire" ? pathname === "/hire" : pathname === href || pathname.startsWith(href + "/"));
  /* Detail screens light the nav item they belong to. */
  const activeHref = (() => {
    if (/^\/hire\/c\//.test(pathname)) return "/hire/candidates";
    if (/^\/hire\/(workspace|voice)\//.test(pathname)) return "/hire/interviews";
    if (/^\/hire\/scoring\//.test(pathname)) return "/hire/review";
    if (/^\/hire\/gate\//.test(pathname)) return "/hire/decisions";
    return null;
  })();

  return (
    <ToastProvider>
      <AppFrame
        header={
          <header className="z-30 flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
            <button
              onClick={toggleRail}
              title={rail ? "Collapse the menu to icons" : "Expand the menu"}
              aria-label={rail ? "Collapse the menu to icons" : "Expand the menu"}
              className="flex h-[34px] w-[34px] flex-none cursor-pointer items-center justify-center rounded-[4px] border border-line bg-surface text-body"
            >
              <Icon n="menu" s={18} />
            </button>
            {apps.length > 1 ? <AppSwitcher apps={apps} current="hire" /> : null}
            <Link href="/apps" title="Back to the MahekOne launcher" className="flex flex-none items-center gap-2 no-underline hover:no-underline">
              <span className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-brand">
                <span className="block h-1.5 w-1.5 rounded-[1px] bg-brand-lime" />
              </span>
              <span className="text-[15px] font-semibold whitespace-nowrap text-heading">MAHEK ONE</span>
            </Link>
            <span className="text-line-strong">›</span>
            <Link href="/hire" className="text-[15px] font-semibold text-brand no-underline hover:no-underline">
              Hire
            </Link>
            <span className="ml-4 hidden md:block">
              <HireSearch />
            </span>
            <span className="flex-1" />
            <span className="hidden flex-none gap-0.5 rounded-[6px] border border-line bg-surface p-[3px] lg:inline-flex" role="group" aria-label="Density">
              {(["comfortable", "compact"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => pickDensity(d)}
                  className={cx("h-7 cursor-pointer rounded-[4px] border-0 px-2.5 text-xs font-medium capitalize", density === d ? "bg-heading text-white" : "bg-transparent text-body")}
                >
                  {d}
                </button>
              ))}
            </span>
            <FeedbackButton />
            <NotificationBell notifications={notifications} />
            <span className="mx-1 h-6 w-px bg-divider" />
            <AccountMenu user={user} hat={hat} variant="header" />
          </header>
        }
        sidebar={
          <aside className={cx("hidden min-h-0 flex-none flex-col border-r border-line bg-surface transition-[width] duration-200 lg:flex", rail ? "w-[240px]" : "w-16")}>
            <nav aria-label="Hire" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
              {nav.map((g) => (
                <div key={g.label} className="mb-3">
                  {rail ? (
                    <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{g.label}</div>
                  ) : (
                    <div className="mx-3 my-2 h-px bg-divider" />
                  )}
                  {g.items.map((it) => {
                    const on = activeHref ? activeHref === it.href : isActive(it.href);
                    const c = counts[it.key];
                    return (
                      <Link
                        key={it.key}
                        href={it.href}
                        title={rail ? undefined : it.label}
                        className={cx(
                          "relative flex h-9 items-center gap-2.5 rounded-[4px] text-sm no-underline hover:bg-canvas hover:no-underline",
                          rail ? "justify-start px-2.5" : "justify-center px-0",
                          on ? "bg-brand-soft font-medium text-brand-hover shadow-[inset_3px_0_0_var(--color-brand)]" : "text-body",
                        )}
                      >
                        <Icon n={it.icon} s={20} />
                        {rail ? <span className="flex-1 truncate">{it.label}</span> : null}
                        {c && c.n ? (
                          <span
                            className={cx(
                              "rounded-[9px] text-center text-[11px] leading-[18px] font-semibold tabular-nums",
                              c.over ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn-ink",
                              rail ? "h-[18px] min-w-5 px-1.5" : "absolute top-0.5 right-1.5 h-4 min-w-4 px-1 leading-4",
                            )}
                          >
                            {c.n}
                          </span>
                        ) : null}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </nav>
            <div className="flex flex-none items-center border-t border-divider px-2 py-2">
              <AccountMenu user={user} hat={hat} variant="sidebar" collapsed={!rail} />
            </div>
          </aside>
        }
      >
        <div data-density={density} className="hire-root min-h-full bg-page">
          {aiDown ? (
            <div className="flex items-center gap-2 border-b border-warn-line bg-warn-soft px-6 py-2 text-[13px] text-warn-ink">
              <Icon n="warn" s={14} />
              {aiDown}
            </div>
          ) : null}
          <div className="px-6 pt-6 pb-12">{children}</div>
        </div>
      </AppFrame>
    </ToastProvider>
  );
}

/** Search candidates, roles and people — only what this person can open. `/` focuses it. */
function HireSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<HireSearchHit[]>([]);
  const [asked, setAsked] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setQ("");
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setQ("");
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const t = setTimeout(() => {
      void hireSearch(term).then((r) => {
        setHits(r);
        setAsked(term);
      });
    }, 160);
    return () => clearTimeout(t);
  }, [q]);
  const open = q.trim().length >= 2 && asked === q.trim();
  return (
    <div ref={wrapRef} className="relative w-[400px]">
      <Icon n="search" s={16} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search candidates, roles…   /"
        className="h-[34px] w-full rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm text-heading outline-none focus:border-brand focus:bg-surface"
      />
      {open ? (
        <div className="absolute top-10 right-0 left-0 z-40 overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(26,30,40,0.12)]">
          {hits.length ? (
            (["Candidates", "Roles"] as const).map((g) => {
              const items = hits.filter((h) => h.group === g);
              if (!items.length) return null;
              return (
                <div key={g}>
                  <div className="bg-page px-3 pt-2 pb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{g}</div>
                  {items.map((h) => (
                    <button
                      key={h.href}
                      onClick={() => {
                        setQ("");
                        router.push(h.href);
                      }}
                      className="flex w-full cursor-pointer items-center gap-2.5 border-0 border-t border-canvas bg-surface px-3 py-2 text-left hover:bg-canvas"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-heading">{h.name}</span>
                        <span className="block truncate text-[13px] text-muted">{h.meta}</span>
                      </span>
                    </button>
                  ))}
                </div>
              );
            })
          ) : (
            <div className="px-3 py-3.5 text-[13px] text-muted">Nothing you can open matches “{q.trim()}”.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
