"use client";

import { useState } from "react";
import { AppFrame } from "@/components/shell/app-frame";
import { CollapsibleNav, type NavRowItem } from "@/components/shell/collapsible-nav";
import { HeaderLead } from "@/components/shell/header-lead";
import { Icon } from "@/components/shell/icons";
import { cx } from "@/components/ui/primitives";
import type { AppDefinition } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * The Website Enquiries shell: the header every app opens with (switcher,
 * collapse, wordmark) and its modules in a sidebar that rails to icons. The
 * modules sat in a top-nav while there were two of them; the collapse is
 * mandatory in every app, and a collapse needs a column to collapse.
 * ------------------------------------------------------------------------- */

export function EnquiriesShell({
  apps,
  label,
  modules,
  headerRight,
  children,
}: {
  apps: AppDefinition[];
  label: string;
  /** Only the modules this person holds. */
  modules: NavRowItem[];
  /** The person, Tell us and Sign out — server-rendered by the layout. */
  headerRight: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <AppFrame
      header={
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
          <HeaderLead
            apps={apps}
            current="enquiries"
            collapsed={collapsed}
            onToggleSidebar={() => setCollapsed((c) => !c)}
            href="/enquiries"
            label={label}
          />
          <span className="flex-1" />
          {headerRight}
        </header>
      }
      sidebar={
        <aside className={cx("flex flex-none flex-col border-r border-line bg-surface transition-[width] duration-150", collapsed ? "w-14" : "w-[216px]")}>
          <CollapsibleNav
            storageKey="enquiries.nav.open"
            ariaLabel="Enquiries sections"
            pinned={modules}
            groups={[]}
            countFor={() => 0}
            railed={collapsed}
            renderIcon={(name, size) => <Icon name={name} size={size} className="flex-none" />}
          />
        </aside>
      }
    >
      {children}
    </AppFrame>
  );
}
