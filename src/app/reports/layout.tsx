import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";
import { initialsOf } from "@/lib/format";
import { ReportsShell } from "./reports-shell";

/**
 * The Reports app's shell and its gate.
 *
 * The access rule is the GRANT, not a role — whoever is given Reports opens
 * it. That matters more here than elsewhere: this app answers "how is the
 * business doing" across every salesman, so it is exactly the app somebody
 * would want to reach by typing the URL, and the check has to live where a
 * bookmark cannot get past it.
 *
 * Somebody holding the app but no module inside it is sent back to the
 * launcher rather than shown an empty frame, which is what every other app
 * here does.
 */
export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("reports")) redirect("/apps");

  const modules = await listUserModules(user.id, "reports");
  if (modules.length === 0) redirect("/apps");

  return (
    <ToastProvider>
      <ReportsShell
        user={{ name: user.name, initials: initialsOf(user.name) }}
        allowed={modules.map((m) => m.href)}
        switcher={
          apps.length > 1 ? (
            <AppSwitcher apps={webApps(apps)} current="reports" />
          ) : null
        }
        feedback={<FeedbackButton />}
      >
        {children}
      </ReportsShell>
    </ToastProvider>
  );
}
