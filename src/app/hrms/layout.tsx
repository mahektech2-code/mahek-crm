import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { APPS, getApp } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { Wordmark } from "@/components/shell/wordmark";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";

/**
 * The HRMS shell.
 *
 * Like the Orders app and unlike the CRM: no calling sidebar, because nobody
 * works a queue in here. There is one module today — All Employees — and it
 * still gets a module row, because the second one arrives beside it rather
 * than rearranging the app somebody has learned.
 */
const MODULES = [{ href: "/hrms/employees", label: "All Employees" }];

export default async function HrmsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);

  // Checked here as well as on the launcher: a bookmarked /hrms must not open
  // for somebody who was never given it. Salaries and home addresses are in
  // here, so this is the check that matters most in the app.
  if (!apps.includes("hrms")) redirect("/apps");

  // One module today, and it still gets filtered rather than assumed — the
  // second one arrives beside it rather than rearranging this.
  const modules = await listUserModules(user.id, "hrms");
  if (modules.length === 0) redirect("/apps");

  const app = getApp("hrms")!;

  return (
    <ToastProvider>
      <div className="animate-fade-in flex min-h-screen flex-col bg-canvas">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
          {apps.length > 1 ? (
            <AppSwitcher
              apps={APPS.filter((a) => apps.includes(a.id))}
              current="hrms"
            />
          ) : null}
          <Wordmark label={app.name} />
          <nav className="ml-4 flex items-center gap-1">
            {MODULES.filter((m) => modules.some((a) => a.href === m.href)).map((m) => (
              <Link
                key={m.href}
                href={m.href}
                className="rounded-[4px] px-3 py-1.5 text-[13px] font-medium text-body hover:bg-canvas"
              >
                {m.label}
              </Link>
            ))}
          </nav>
          <span className="flex-1" />
          <span className="text-[13px] text-muted">
            {user.name} · {user.role}
          </span>
          <FeedbackButton compact />
          <SignOutButton />
        </header>

        <div className="flex-1">{children}</div>
      </div>
    </ToastProvider>
  );
}
