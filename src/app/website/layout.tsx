import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { canEditAny, holdsReview } from "@/lib/website-cms/access";
import { pendingReviewCount, scopeFor } from "@/lib/website-cms/review-queries";
import { slugVisible } from "@/lib/website-cms/review-scope";
import { ConnectionNotice } from "./connection-notice";
import { WebsiteShell } from "./website-shell";

/**
 * The Website app's shell.
 *
 * Like every other MahekOne app: the grant is a row in `app_access`, checked
 * here as well as on the launcher, because a bookmarked `/website` must not
 * open for somebody who was never given the app. Content behind these 12
 * screens is the website's own content — see `lib/website-cms/` — edited here and read by mahekindia.com.
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

  /* What the sidebar offers is what the person may be SHOWN: where assignments are
     enforced, a module they were assigned nothing in is not drawn (and its route
     sends them to My work). The check is the folder's own layout; this is the courtesy. */
  const scope = await scopeFor(user.id);
  const slugOf = (href: string) => href.replace(/^\/website\/?/, "") || "dashboard";
  const allowed = modules.map((m) => m.href).filter((href) => slugVisible(scope, slugOf(href)));
  const isReviewer = await holdsReview(user.id);
  const work = {
    myWork: isReviewer || (await canEditAny(user.id)),
    review: isReviewer,
    pendingReview: isReviewer ? await pendingReviewCount() : 0,
  };

  return (
    <ToastProvider>
      <WebsiteShell
        user={{ name: user.name, initials: initialsOf(user.name), role: hat.label }}
        allowed={allowed}
        work={work}
        apps={webApps(apps)}
        feedback={<FeedbackButton />}
      >
        <ConnectionNotice />
        {children}
      </WebsiteShell>
    </ToastProvider>
  );
}
