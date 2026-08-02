"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "./nav";
import { Icon } from "./icons";
import { cx } from "@/components/ui/primitives";
import { signOut } from "@/lib/actions/auth";
import type { User } from "@/db/schema";

export function Sidebar({
  collapsed,
  user,
  badges,
}: {
  collapsed: boolean;
  user: User;
  badges: { reminders: number; complaints: number };
}) {
  const pathname = usePathname();

  return (
    <aside
      className={cx(
        "flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150",
        collapsed ? "w-14" : "w-[216px]",
      )}
    >
      <nav className="flex-1 overflow-y-auto px-1.5 pt-2 pb-4">
        {NAV.map((group) => (
          <div key={group.label}>
            {!collapsed ? (
              <div className="px-2.5 pt-3.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                {group.label}
              </div>
            ) : (
              <div className="my-2 border-t border-divider" />
            )}
            {group.items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + "/");
              const count =
                item.badge === "reminders"
                  ? badges.reminders
                  : item.badge === "complaints"
                    ? badges.complaints
                    : 0;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={cx(
                    "mb-0.5 flex h-9 items-center gap-2.5 rounded-[4px] px-2.5 text-sm no-underline hover:no-underline",
                    active
                      ? "bg-brand-soft font-medium text-[#5223E0]"
                      : "text-body hover:bg-canvas hover:text-ink",
                    collapsed && "justify-center px-0",
                  )}
                >
                  <Icon name={item.icon} size={20} className="flex-none" />
                  {!collapsed ? (
                    <>
                      <span className="truncate">{item.label}</span>
                      <span className="flex-1" />
                      {count > 0 ? (
                        <span
                          className={cx(
                            "inline-flex h-5 min-w-5 items-center justify-center rounded-[3px] px-1 text-[11px] font-medium",
                            item.badge === "complaints"
                              ? "bg-danger-soft text-danger"
                              : "bg-warn-soft text-warn-ink",
                          )}
                        >
                          {count}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex flex-none items-center gap-2.5 border-t border-divider px-3 py-2.5">
        <span className="flex h-7.5 w-7.5 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
          {user.initials}
        </span>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-4 font-medium text-ink">
                {user.name}
              </span>
              <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                {user.role}
              </span>
            </span>
            <form action={signOut}>
              <button
                type="submit"
                title="Sign out"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
              >
                <Icon name="signOut" size={16} />
              </button>
            </form>
          </>
        ) : null}
      </div>
    </aside>
  );
}
