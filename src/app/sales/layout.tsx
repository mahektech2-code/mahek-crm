import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { APPS } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { ToastProvider } from "@/components/ui/toast";
import { initialsOf } from "@/lib/format";
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

  return (
    <ToastProvider>
      <SalesShell
        user={{
          name: user.name,
          /* From the SCOPE, not the role. A regional manager labelled
           * "National sales manager" is the header lying about the one thing
           * it is drawn to say. */
          title: counts.title,
          initials: initialsOf(user.name),
        }}
        teamLine={counts.teamLine}
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
            <AppSwitcher apps={APPS.filter((a) => apps.includes(a.id))} current="sales" />
          ) : null
        }
        feedback={<FeedbackButton />}
      >
        {children}
      </SalesShell>
    </ToastProvider>
  );
}
