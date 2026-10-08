import { redirect } from "next/navigation";
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
 * Two modules today — Overview and the worklist itself — in a sidebar that
 * collapses to icons, like every other app's. A third arrives beside them
 * rather than rearranging the app somebody has already learned.
 */
const MODULES = [
  { href: "/enquiries", label: "Overview", icon: "dashboard", exact: true },
  { href: "/enquiries/list", label: "Enquiries", icon: "mail" },
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
      {/* The floor and the scroll model are the frame's, inside the shell —
          see `components/shell/app-frame.tsx`. */}
      <EnquiriesShell
        apps={webApps(apps)}
        label={app.name}
        modules={MODULES.filter((m) => modules.some((a) => a.href === m.href))}
        headerRight={
          <>
            <span className="text-[13px] text-muted">
              {user.name} · {hat.label}
            </span>
            <FeedbackButton compact />
            <SignOutButton />
          </>
        }
      >
        {children}
      </EnquiriesShell>
    </ToastProvider>
  );
}
