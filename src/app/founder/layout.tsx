import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";
import { initialsOf } from "@/lib/format";
import { FounderShell } from "./founder-shell";

/**
 * The Founder Dashboard's shell and its gate.
 *
 * Same rule as Reports: the access is the GRANT, not a role. This is the one
 * app that rolls every other app up into a single reading of the company, so
 * the check has to live where a bookmark cannot get past it, same as
 * `reports/layout.tsx`.
 */
export default async function FounderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("founder")) redirect("/apps");

  const modules = await listUserModules(user.id, "founder");
  if (modules.length === 0) redirect("/apps");

  return (
    <ToastProvider>
      <FounderShell
        user={{ name: user.name, initials: initialsOf(user.name) }}
        allowed={modules.map((m) => m.href)}
        switcher={
          apps.length > 1 ? (
            <AppSwitcher apps={webApps(apps)} current="founder" />
          ) : null
        }
        feedback={<FeedbackButton />}
      >
        {children}
      </FounderShell>
    </ToastProvider>
  );
}
