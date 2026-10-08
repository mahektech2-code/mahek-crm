import type { Metadata } from "next";
import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { addYmd, hireStaff, istYmd, mondayOf, toSchedule, weekEvents } from "@/lib/hire/services/schedule";
import { PageHead } from "../_ui/kit";
import { CalendarView } from "./calendar-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Calendar" };

/** Interviews this week, and booking the ones still waiting. Nothing is booked until a person confirms. */
export default async function HireCalendarPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const ctx = await requireHireScreen("calendar");
  const now = nowMs();
  const sp = await searchParams;
  const monday = mondayOf(sp.w && /^\d{4}-\d{2}-\d{2}$/.test(sp.w) ? sp.w : istYmd(now));
  const canSchedule = ctx.can("addCandidate");
  const [events, waiting, staff] = await Promise.all([weekEvents(ctx, monday), canSchedule ? toSchedule(ctx, now) : Promise.resolve([]), canSchedule ? hireStaff() : Promise.resolve([])]);
  return (
    <>
      <PageHead title="Calendar" sub="Interviews this week. Proposed times come from the interviewer’s and the candidate’s bookings; nothing is booked until a person confirms." />
      <CalendarView
        monday={monday}
        prev={addYmd(monday, -7)}
        next={addYmd(monday, 7)}
        today={istYmd(now)}
        events={events}
        waiting={waiting}
        staff={staff}
        meId={ctx.user.id}
        canSchedule={canSchedule}
      />
    </>
  );
}
