import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { listUserModules } from "@/lib/access";
import { moduleForPath } from "@/lib/modules";
import { today } from "@/lib/recompute";
import { managerLeadBlocks } from "@/lib/services/lead-dashboard-service";
import { Empty } from "@/components/console/parts";
import { LeadTabs } from "@/components/leads/lead-tabs";
import { DashboardScreen } from "@/components/leads/dashboard/dashboard-screen";

/**
 * §8.2 — the sales manager's seven management blocks.
 *
 * The screen is `dashboard-screen.tsx` and the counts are
 * `lead-dashboard-service.ts`; what lives here is the three things a route has
 * to decide — which business day the week is measured from, which of the seven
 * this particular person can actually open, and what to say when that comes to
 * none.
 *
 * **THE CLOCK IS READ HERE AND NOWHERE ELSE.** The seventh block is a forecast
 * over the next seven days, and the day it counts from is the working day in
 * Asia/Kolkata rather than whatever zone the database session happens to be
 * in — `today()` applies the configured boundary and the service takes the
 * answer as a parameter. A client component may not read the clock during
 * render at all, which is the React Compiler rule this codebase runs under, and
 * a `now()` inside the statement would have been the bare-cast bug in its usual
 * clothing.
 *
 * **A TILE THAT OPENS NOTHING IS WORSE THAN AN ABSENT ONE, so the strip is
 * narrowed to the modules this person holds.** Every block is a door, and four
 * of the seven lead out of All Leads into Qualification, Samples and
 * Commercial — which are separately grantable, and are deliberately withheld
 * from people who do not do that work. Drawn anyway, a withheld block would
 * hand somebody a count off a screen they were refused and then bounce them
 * off `requireModule` when they pressed it, which reads as a broken link
 * rather than as a grant they were never given. It is the same rule the
 * sidebar already follows — it draws only what somebody holds — and this
 * dashboard must not be the one place a narrowed grant is quietly widened.
 *
 * **Narrowed to nothing is a sentence, not a blank page.** Somebody holding
 * All Leads alone sees no blocks at all, and an empty grid with a heading over
 * it reads as a screen that failed to load. It says which it is.
 *
 * The guard is `dashboard/layout.tsx`, which holds `<workspace>.leads`.
 * Nothing in here re-checks it: one gate per route, in the layout the route
 * sits under.
 */
export async function Body({ workspace }: { workspace: LeadWorkspace }) {
  const user = await requireUser();

  const [day, held] = await Promise.all([today(), listUserModules(user.id, workspace)]);
  const blocks = await managerLeadBlocks(day);

  const keys = new Set(held.map((m) => m.key));
  const open = blocks.filter((b) => {
    /* Resolved against the registry rather than matched on a prefix: the
       registry is what a grant points at and what the route guard enforces, so
       asking it is the only way this screen and that guard cannot disagree
       about one href. A block whose destination is registered nowhere is drawn
       — it is a screen nobody can be refused, so there is nothing to withhold. */
    const mod = moduleForPath(leadHref(workspace, b.href));
    return !mod || keys.has(mod.key);
  });

  return (
    <>
      <LeadTabs workspace={workspace} />
      {open.length === 0 ? (
        <Empty
          title="Nothing on this dashboard for you"
          body="Every block here opens a queue in Qualification, Samples or Commercial, and none of those has been granted to you. Ask a manager for the ones you work in."
        />
      ) : (
        <DashboardScreen workspace={workspace} blocks={open} />
      )}
    </>
  );
}
