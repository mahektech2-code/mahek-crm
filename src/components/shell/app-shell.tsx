"use client";

import * as React from "react";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import { ToastProvider } from "@/components/ui/toast";
import type { Notification, User } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";
import type { NavGroup } from "./nav";

export function AppShell({
  user,
  isManager,
  scope,
  notifications,
  badges,
  apps,
  nav,
  children,
}: {
  user: User;
  isManager: boolean;
  scope: "mine" | "team";
  notifications: Notification[];
  badges: { reminders: number; complaints: number; statusRequests: number };
  apps: AppDefinition[];
  /** The sidebar, already narrowed to what this person may open. */
  nav: NavGroup[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <ToastProvider>
      {/* The design carries a 1000px floor: below that the sidebar and a
          data table cannot both be honest, so the page scrolls instead. */}
      <div className="flex h-screen min-w-[1000px] flex-col overflow-hidden bg-canvas">
        <Header
          user={user}
          isManager={isManager}
          scope={scope}
          notifications={notifications}
          apps={apps}
          onToggleSidebar={() => setCollapsed((c) => !c)}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar collapsed={collapsed} user={user} badges={badges} groups={nav} />
          <main className="relative min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
