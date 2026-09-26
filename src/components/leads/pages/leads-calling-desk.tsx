import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import { requireUser } from "@/lib/auth";
import { canLead } from "@/lib/services/lead-console-service";
import { nowMs } from "@/lib/format";
import { APP_TIMEZONE } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { isDeskView, type DeskView } from "@/lib/engines/lead-calling-desk";
import { callingDesk } from "@/lib/services/lead-calling-desk-service";
import { Dashboard } from "@/components/leads/calling-desk/dashboard";

/**
 * The Telecaller dashboard's route body.
 *
 * What is drawn is `calling-desk/dashboard.tsx`, and what it is drawn from is
 * `lead-calling-desk-service.ts`; what lives here is the three things a route
 * has to decide — which business day the calls are due against, which view the
 * address asked for, and who to greet.
 *
 * The page is handed EVERY lead in the desk's book and filters them itself: a
 * tile pressed on the screen changes the list in place, with no navigation. The
 * `?view=` here is only where it opens — a desk with "Call 2 pending" open is a
 * link somebody can send.
 *
 * **THE CLOCK IS READ HERE AND NOWHERE ELSE.** `today()` applies the configured
 * boundary and every read below takes the answer as a parameter — a `now()`
 * inside a statement would read in the database session's zone. The greeting's
 * hour is read in Asia/Kolkata for the same reason: a server in GMT would say
 * "Good morning" to somebody finishing their afternoon.
 *
 * There is no `LeadTabs` strip: the Version 6 design is a workspace of its own,
 * and the existing lead pages are one click away through the CRM's own sidebar.
 * The guard is `calling-desk/layout.tsx`, which holds `<workspace>.leads`.
 */
export async function Body({
  workspace,
  searchParams,
}: {
  workspace: LeadWorkspace;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const raw = Array.isArray(query.view) ? query.view[0] : query.view;
  const view: DeskView = isDeskView(raw) ? raw : "queue";

  const [day, user] = await Promise.all([today(), requireUser()]);
  const desk = await callingDesk(day, view);

  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: APP_TIMEZONE }).format(
      new Date(nowMs()),
    ),
  );
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const first = (user.name ?? "").split(" ")[0] || "there";

  return (
    <Dashboard
      all={desk.all}
      day={day}
      initialView={view}
      greeting={`Good ${part}, ${first}`}
      base={leadHref(workspace, "leads/calling-desk")}
      intakeHref={leadHref(workspace, "leads/intake")}
      canAssign={await canLead(user, "lead.verify")}
    />
  );
}
