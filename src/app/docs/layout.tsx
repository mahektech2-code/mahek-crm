import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { ToastProvider } from "@/components/ui/toast";
import index from "@/docs/_generated/index.json";
import { DOC_APPS, docPage } from "@/docs/registry";
import { DocsShell, type SearchEntry } from "./docs-shell";

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
 */
export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("docs")) redirect("/apps");
  const hat = await hatForHeader(user, "docs");

  const search: SearchEntry[] = [
    ...DOC_APPS.flatMap((a) =>
      a.pages.map((p) => ({ app: a.app, slug: p.slug, tab: null, title: p.title, heading: null, id: null, text: p.summary })),
    ),
    ...(index.search as Array<Omit<SearchEntry, "title">>).flatMap((s) => {
      const page = docPage(s.app, s.slug);
      return page ? [{ ...s, title: page.title }] : [];
    }),
  ];

  return (
    <ToastProvider>
      <DocsShell
        user={{ name: user.name, initials: initialsOf(user.name), role: hat.label }}
        apps={webApps(apps)}
        search={search}
      >
        {children}
      </DocsShell>
    </ToastProvider>
  );
}
