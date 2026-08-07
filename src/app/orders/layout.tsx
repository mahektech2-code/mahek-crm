import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { APPS, getApp } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { Wordmark } from "@/components/shell/wordmark";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { ToastProvider } from "@/components/ui/toast";

/**
 * The Orders app's own shell.
 *
 * Deliberately not the CRM's `AppShell`: that carries the calling sidebar and
 * its reminder and complaint badges, and accounts have no calling book. What
 * they need is the switcher, their name, a way out, and somewhere for toasts
 * to appear — approving an order says so, and without a provider above it the
 * screen throws rather than confirming anything.
 */
export default async function OrdersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);

  // Checked here as well as on the launcher: a bookmarked /orders must not
  // open for somebody who was never given the app.
  if (!apps.includes("orders")) redirect("/apps");

  const app = getApp("orders")!;

  return (
    <ToastProvider>
      <div className="animate-fade-in flex min-h-screen flex-col bg-canvas">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
          {apps.length > 1 ? (
            <AppSwitcher
              apps={APPS.filter((a) => apps.includes(a.id))}
              current="orders"
            />
          ) : null}
          <Wordmark label={app.name} />
          <span className="flex-1" />
          <span className="text-[13px] text-muted">
            {user.name} · {user.role}
          </span>
          <SignOutButton />
        </header>

        <div className="flex-1">{children}</div>
      </div>
    </ToastProvider>
  );
}
