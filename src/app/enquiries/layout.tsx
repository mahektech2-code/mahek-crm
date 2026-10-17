import { redirect } from "next/navigation";
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
 * Like HRMS and unlike the CRM: no calling sidebar. The app is one page, so
 * there is no module nav to draw — the wordmark is the way home.
 */

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
