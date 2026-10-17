import { today } from "@/lib/recompute";
import { fieldTeam } from "@/lib/services/sales-service";
import { holidayCalendar } from "@/lib/services/holiday-service";
import { HolidaysScreen, type HolidaysView } from "./holidays-screen";

export const metadata = { title: "Holidays — Sales Dashboard — MahekOne" };

/**
 * The holiday calendar, by day, by level and by person.
 *
 * The holidays are the company's and every one is shown; the PEOPLE are the
 * manager's own team (`fieldTeam`, which `managerScope` narrows), so a regional
 * manager reads who in his region gets each day and nobody else.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; view?: string; person?: string }>;
}) {
  const params = await searchParams;
  const day = await today();
  const thisYear = Number(day.slice(0, 4));
  const asked = Number(params.year);
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : thisYear;
  const view: HolidaysView =
    params.view === "levels" || params.view === "people" ? params.view : "calendar";

  const team = (await fieldTeam()).map((p) => p.id);
  const calendar = await holidayCalendar(year, team);
  const person = calendar.people.some((p) => p.id === params.person) ? params.person! : null;

  return <HolidaysScreen calendar={calendar} todayIso={day} view={view} person={person} />;
}
