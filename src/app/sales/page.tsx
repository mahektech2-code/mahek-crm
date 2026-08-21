import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { APP_TIMEZONE, addDays } from "@/lib/business-date";
import { today } from "@/lib/recompute";
import { consoleCounts, teamDay } from "@/lib/services/sales-service";
import { TodayScreen } from "./today-screen";

export const metadata = { title: "Today — Sales Dashboard — MahekOne" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const user = await requireUser();

  // Today is a module like any other and it is the app's root, so it cannot
  // have a folder layout of its own to guard it — the guard runs here.
  await requireModule(user.id, "sales.today");

  const params = await searchParams;
  const now = await today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.day ?? "") ? params.day! : now;

  const [data, counts] = await Promise.all([
    teamDay(day),
    consoleCounts(day, addDays(day, 1)),
  ]);

  /* The clock is read here and passed down. A client component may not read it
   * during render, and the zone is named once rather than left to whatever the
   * browser happens to be set to. */
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
  const firstName = user.name.split(" ")[0];

  return (
    <TodayScreen
      day={day}
      isToday={day === now}
      greeting={`${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${firstName}`}
      dayLabel={new Intl.DateTimeFormat("en-GB", {
        timeZone: APP_TIMEZONE,
        weekday: "long",
        day: "numeric",
        month: "short",
      }).format(new Date(`${day}T06:00:00+05:30`))}
      data={data}
      waiting={[
        {
          href: "/sales/orders",
          label: "Orders over the credit limit",
          sub: "Nothing dispatches until you decide",
          count: counts.orders,
          tone: "danger",
        },
        {
          href: "/sales/expenses",
          label: "Expense claims",
          sub: "Money the field is owed back",
          count: counts.expenses,
          tone: "amber",
        },
        {
          href: "/sales/samples",
          label: "Samples awaiting feedback",
          sub: "All past their follow-up date",
          count: counts.samples,
          tone: "amber",
        },
        {
          href: "/sales/leave",
          label: "Leave requests",
          sub: "Somebody is waiting to book time off",
          count: counts.leave,
          tone: "neutral",
        },
        {
          href: "/sales/journeys",
          label: "Days he will not walk",
          sub: "Refused with a reason, waiting on your answer",
          count: counts.refused,
          tone: "warn",
        },
        {
          href: "/sales/journeys",
          label: "Salesmen with nothing tomorrow",
          sub: "They will decide for themselves where to go",
          count: counts.unplanned,
          tone: "neutral",
        },
      ]}
    />
  );
}
