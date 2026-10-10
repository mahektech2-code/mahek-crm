import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { ToastProvider } from "@/components/ui/toast";
import { DocsShell } from "./docs-shell";

export const metadata: Metadata = {
  title: { template: "%s · Documentation · MahekOne", default: "Documentation · MahekOne" },
};

/**
 * The Documentation app's gate and shell.
 *
 * Like every MahekOne app the grant is a row in `app_access`, checked here and
 * not only on the launcher — a bookmarked `/docs` must not open for somebody
 * never given it. Everybody granted reads every app's pages and every tab:
 * that was a decision, recorded on the module in `lib/modules.ts`.
 *
 * Search is NOT shipped from here any more: ⌘K asks `/api/docs/search`, so a
 * docs page no longer carries the whole search index into the browser.
 */
export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("docs")) redirect("/apps");
  const hat = await hatForHeader(user, "docs");


  return (
    <ToastProvider>
      <DocsShell
        user={{ name: user.name, initials: initialsOf(user.name), role: hat.label }}
        apps={webApps(apps)}
      >
        {children}
      </DocsShell>
    </ToastProvider>
  );
}
