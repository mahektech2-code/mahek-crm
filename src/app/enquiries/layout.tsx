import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { getApp, webApps } from "@/lib/apps";
import { AppFrame } from "@/components/shell/app-frame";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { Wordmark } from "@/components/shell/wordmark";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { hatForHeader } from "@/lib/hat-for-header";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";

/**
 * The Website Enquiries shell.
 *
 * Like HRMS and unlike the CRM: no calling sidebar, and few enough modules
 * that a flat top-nav says everything the sidebar would. Two modules today —
 * Overview and the worklist itself — and a third arrives beside them rather
 * than rearranging the app somebody has already learned.
 */
const MODULES = [
  { href: "/enquiries", label: "Overview" },
  { href: "/enquiries/list", label: "Enquiries" },
];

export default async function EnquiriesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);

  // Checked here as well as on the launcher: a bookmarked /enquiries must not
  // open for somebody who was never given the app.
  if (!apps.includes("enquiries")) redirect("/apps");

  const modules = await listUserModules(user.id, "enquiries");
  if (modules.length === 0) redirect("/apps");

  const hat = await hatForHeader(user, "enquiries");

  const app = getApp("enquiries")!;

  return (
    <ToastProvider>
      {/* The floor and the scroll model are the frame's — this app stated
          neither, which is how an app ends up with no floor at all. See
          `components/shell/app-frame.tsx`. */}
      <AppFrame
        header={
            <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
              {apps.length > 1 ? (
                <AppSwitcher apps={webApps(apps)} current="enquiries" />
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
                {user.name} · {hat.label}
              </span>
              <FeedbackButton compact />
              <SignOutButton />
            </header>
        }
      >
        {children}
      </AppFrame>
    </ToastProvider>
  );
}
