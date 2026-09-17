import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { consoleCounts } from "@/lib/services/sales-service";
import { SalesShell } from "./sales-shell";

/**
 * The Manager Console's own shell.
 *
 * The access rule for this app is the GRANT and not a role: whoever is given
 * the Sales Dashboard opens it. That is also why `field` and `sales` are two
 * apps rather than one — `field` is what MBOS sign-in checks, and a grant with
 * no module rows means every module of it.
 *
 * The counts are read once here rather than by each screen for itself: the
 * sidebar badges them on every route, and eight screens asking the same eight
 * questions on every navigation is eight round trips nobody sees.
 */
export default async function SalesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);

  // Checked here as well as on the launcher: a bookmarked /sales must not open
  // for somebody who was never given the app.
  if (!apps.includes("sales")) redirect("/apps");

  const modules = await listUserModules(user.id, "sales");
  if (modules.length === 0) redirect("/apps");

  const day = await today();
  const counts = await consoleCounts(day, addDays(day, 1));
  const hat = await hatForHeader(user, "sales");

  return (
    <ToastProvider>
      <SalesShell
        user={{
          name: user.name,
          /*
           * THE LEVEL HELD ON THIS APP, not a rank derived from the scope.
           *
           * This read `counts.title` — "National sales manager", worked out
           * from how many regions somebody covers. It is not a level, it is
           * stored nowhere, and it is a job title the company does not issue,
           * so an ASSOCIATE granted the Sales Dashboard was greeted as a
           * national manager. The scope it came from is not lost: the team
           * line beside the wordmark says "11 salesmen · All India · 7
           * regions", which is the same fact without the invented rank.
           */
          title: hat.label,
          titleSentence: hat.sentence,
          initials: initialsOf(user.name),
        }}
        teamLine={counts.teamLine}
        scopeDetail={counts.scopeDetail}
        liveLine={counts.liveLine}
        counts={{
          "/sales/tasks": counts.tasks,
          "/sales/journeys": counts.refused,
          "/sales/orders": counts.orders,
          "/sales/samples": counts.samples,
          "/sales/leave": counts.leave,
          "/sales/expenses": counts.expenses,
        }}
        alertCount={counts.alerts}
        allowed={modules.map((m) => m.href)}
        switcher={
          apps.length > 1 ? (
            <AppSwitcher apps={webApps(apps)} current="sales" />
          ) : null
        }
        feedback={<FeedbackButton />}
      >
        {children}
      </SalesShell>
    </ToastProvider>
  );
}
