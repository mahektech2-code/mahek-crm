"use client";

import * as React from "react";
import { AppFrame } from "./app-frame";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
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
  children,
}: {
  user: User;
  /** Who this person is in THIS app — resolved by the layout, which knows. */
  hat: { label: string; sentence: string };
  isManager: boolean;
  scope: "mine" | "team";
  notifications: Notification[];
  badges: { reminders: number; complaints: number; statusRequests: number };
  apps: AppDefinition[];
  /** The sidebar, already narrowed to what this person may open. */
  nav: NavGroup[];
  /** The rows above it, narrowed the same way. */
  pinnedNav: NavItem[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <ToastProvider>
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
            onToggleSidebar={() => setCollapsed((c) => !c)}
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
    </ToastProvider>
  );
}
