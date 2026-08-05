"use client";

import * as React from "react";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import { ToastProvider } from "@/components/ui/toast";
import type { Notification, User } from "@/db/schema";
import type { AppDefinition } from "@/lib/apps";

export function AppShell({
  user,
  isManager,
  scope,
  density,
  notifications,
  badges,
  apps,
  children,
}: {
  user: User;
  isManager: boolean;
  scope: "mine" | "team";
  density: "comfortable" | "compact";
  notifications: Notification[];
  badges: { reminders: number; complaints: number };
  apps: AppDefinition[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  return (
    <ToastProvider>
      {/* The design carries a 1000px floor: below that the sidebar and a
          data table cannot both be honest, so the page scrolls instead. */}
      <div className="flex h-screen min-w-[1000px] flex-col overflow-hidden bg-canvas">
        <Header
          user={user}
          isManager={isManager}
          scope={scope}
          density={density}
          notifications={notifications}
          apps={apps}
          onToggleSidebar={() => setCollapsed((c) => !c)}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar collapsed={collapsed} user={user} badges={badges} />
          <main className="relative min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
