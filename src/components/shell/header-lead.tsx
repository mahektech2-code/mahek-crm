"use client";

import Link from "next/link";
import { Icon } from "./icons";
import { AppSwitcher } from "./app-switcher";
import type { AppDefinition, AppId } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * THE LEFT END OF EVERY APP'S HEADER, and the one place it is drawn.
 *
 * The app switcher, the sidebar collapse and the app's wordmark, in that order,
 * in every MahekOne app. They were written out by hand in each shell and had
 * drifted: some apps drew no switcher, several had no way to collapse the
 * sidebar, and the CRM hid the switcher from anybody holding a single app —
 * which is also the person with no other way back to the launcher. Mahek's
 * instruction is that these are MANDATORY in every app, so they are one
 * component and every shell renders it; `shell-header-parity.test.ts` fails
 * the build on a shell that does not.
 *
 * The switcher is drawn whatever the person holds. With one app it is still
 * the door to the launcher, and a control that appears for some people and not
 * others is one nobody can describe to a colleague.
 * ------------------------------------------------------------------------- */

export function HeaderLead({
  apps,
  current,
  collapsed,
  onToggleSidebar,
  href,
  label,
}: {
  /** Every web app this person opens — what the switcher lists. */
  apps: AppDefinition[];
  current: AppId;
  /** Whether the sidebar is currently the narrow rail. */
  collapsed: boolean;
  onToggleSidebar: () => void;
  /** Where the wordmark goes: the app's own home. */
  href: string;
  /** The app's wordmark as it has always read — "MAHEK CRM", "MBOS MANAGER". */
  label: string;
}) {
  return (
    <div className="flex flex-none items-center gap-2">
      <AppSwitcher apps={apps} current={current} />
      <button
        type="button"
        onClick={onToggleSidebar}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[4px] text-muted hover:bg-canvas hover:text-body"
      >
        <Icon name="menu" size={18} />
      </button>
      <Link href={href} className="flex min-w-0 items-center gap-2 no-underline hover:no-underline">
        <span className="flex h-4 w-4 flex-none items-center justify-center rounded-[3px] bg-brand">
          <span className="block h-1.5 w-1.5 rounded-[1px] bg-brand-lime" />
        </span>
        <span className="truncate text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap text-ink">
          {label}
        </span>
      </Link>
    </div>
  );
}
