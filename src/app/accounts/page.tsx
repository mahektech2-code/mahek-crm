import { checkCapability } from "@/lib/access-control";
import { requireUser } from "@/lib/auth";
import { APP_TIMEZONE } from "@/lib/business-date";
import { accountsHome } from "@/lib/services/accounts-home-service";
import { TodayScreen } from "./today-screen";

export const metadata = { title: "Today — Accounts — MahekOne" };

export default async function Page() {
  const [user, home, { allowed }] = await Promise.all([
    requireUser(),
    accountsHome(),
    // Seeing the desk and deciding on it are different things — the notice at
    // the top says which of the two this person is doing.
    checkCapability("payment.confirm"),
  ]);

  // The clock is read here and passed down as a string. A client component may
  // not read it during render, and the zone is named once rather than left to
  // whatever the browser happens to be set to.
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );

  return (
    <TodayScreen
      home={home}
      userName={user.name}
      canDecide={allowed}
      greeting={hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}
      todayLabel={new Intl.DateTimeFormat("en-GB", {
        timeZone: APP_TIMEZONE,
        weekday: "long",
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(now)}
    />
  );
}
