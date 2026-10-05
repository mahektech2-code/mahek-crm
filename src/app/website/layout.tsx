import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { WebsiteShell } from "./website-shell";

/**
 * The Website app's shell.
 *
 * Like every other MahekOne app: the grant is a row in `app_access`, checked
 * here as well as on the launcher, because a bookmarked `/website` must not
 * open for somebody who was never given the app. Content behind these 12
 * screens is mock data for now — see `mock-data.ts` — so this PR wires up the
 * app, its access and its navigation only.
 */
export default async function WebsiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);

  if (!apps.includes("website")) redirect("/apps");

  const modules = await listUserModules(user.id, "website");
  if (modules.length === 0) redirect("/apps");

  const hat = await hatForHeader(user, "website");

  return (
    <ToastProvider>
      <WebsiteShell
        user={{ name: user.name, initials: initialsOf(user.name), role: hat.label }}
        allowed={modules.map((m) => m.href)}
        switcher={apps.length > 1 ? <AppSwitcher apps={webApps(apps)} current="website" /> : null}
        feedback={<FeedbackButton />}
      >
        {children}
      </WebsiteShell>
    </ToastProvider>
  );
}
