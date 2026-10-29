"use client";

import * as React from "react";
import { AppFrame } from "./app-frame";
import { Header } from "./header";
import { Sidebar, type SidebarBadges } from "./sidebar";
import { ToastProvider } from "@/components/ui/toast";
import type { Notification, User } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";
import type { NavGroup, NavItem } from "./nav";

export function AppShell({
  user,
  hat,
  isManager,
  scope,
  notifications,
  badges,
  apps,
  nav,
  pinnedNav,
  look = "classic",
  app,
  children,
}: {
  user: User;
  /** Who this person is in THIS app — resolved by the layout, which knows. */
  hat: { label: string; sentence: string };
  isManager: boolean;
  scope: "mine" | "team";
  notifications: Notification[];
  badges: SidebarBadges;
  apps: AppDefinition[];
  /** The sidebar, already narrowed to what this person may open. */
  nav: NavGroup[];
  /** The rows above it, narrowed the same way. */
  pinnedNav: NavItem[];
  /** "v4" draws the app in the ERP's look (`styles/v4-theme.css`) — the CRM
   *  asks for it; Accounts, which shares this shell, does not yet. */
  look?: "classic" | "v4";
  /** Which app is wearing it — the sheet keys the CRM's sentence-case labels
   *  on this, so the ERP's own capitals are left alone. */
  app?: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <ToastProvider>
      {/* The marker is all the look needs: the sheet answers to it on :root,
          so portalled dialogs are drawn in the same hand. */}
      <div data-v4={look === "v4" ? "" : undefined} data-v4-app={look === "v4" ? app : undefined} className="contents">
      {/* The floor, the scroll model and the arrival animation are the frame's
          now — see `app-frame.tsx` for why eight apps could not be left to
          state them for themselves. */}
      <AppFrame
        header={
          <Header
            user={user}
            hat={hat}
            isManager={isManager}
            scope={scope}
            notifications={notifications}
            apps={apps}
            collapsed={collapsed}
            onToggleSidebar={() => setCollapsed((c) => !c)}
            v4={look === "v4"}
          />
        }
        sidebar={
          <Sidebar
            collapsed={collapsed}
            user={user}
            hat={hat}
            badges={badges}
            groups={nav}
            pinned={pinnedNav}
          />
        }
      >
        {children}
      </AppFrame>
      </div>
    </ToastProvider>
  );
}
