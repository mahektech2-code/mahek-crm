import { redirect } from "next/navigation";
import { NotificationBell } from "@/components/shell/notification-bell";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { getApp, webApps } from "@/lib/apps";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { hatForHeader } from "@/lib/hat-for-header";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";
import { EnquiriesShell } from "./enquiries-shell";

/**
 * The Website Enquiries shell.
 *
 * One page — the stats and the worklist together — in a sidebar that
 * collapses to icons, like every other app's. Overview and the worklist are
 * still two modules to GRANT, and this page opens for whoever holds either,
 * so the one entry is drawn for anybody who got past the guard below.
 */
const MODULES = [{ href: "/enquiries", label: "Enquiries", icon: "mail", exact: true }];

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
      {/* The floor and the scroll model are the frame's, inside the shell —
          see `components/shell/app-frame.tsx`. */}
      <EnquiriesShell
        apps={webApps(apps)}
        label={app.name}
        modules={MODULES}
        headerRight={
          <>
            <span className="text-[13px] text-muted">
              {user.name} · {hat.label}
            </span>
            <FeedbackButton compact />
            <NotificationBell />
            <SignOutButton />
          </>
        }
      >
        {children}
      </EnquiriesShell>
    </ToastProvider>
  );
}
