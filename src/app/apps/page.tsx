import Link from "next/link";
import { APP_TIMEZONE } from "@/lib/business-date";
import { requireUser } from "@/lib/auth";
import {
  launcherApps,
  listUserApps,
  lockedApps,
  todaysAttendance,
} from "@/lib/access";
import { Wordmark } from "@/components/shell/wordmark";
import { Icon } from "@/components/shell/icons";
import { AccountMenu } from "@/components/shell/account-menu";
import { levelLabel } from "@/lib/hat-labels";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { cx } from "@/components/ui/primitives";
import { clock, longDate, today } from "@/lib/format";
import { AppShortcuts } from "./app-shortcuts";
import { CardGrid } from "@/components/ui/card-grid";
import { LauncherCheckIn } from "@/components/checkin/launcher-check-in";
import { WorkdayProvider } from "@/components/workday/workday-context";
import { WorkdayChip } from "@/components/workday/workday-chip";

export const metadata = { title: "Your apps - MahekOne" };

export default async function LauncherPage() {
  const user = await requireUser();
  const [apps, ids, attendance] = await Promise.all([
    launcherApps(user),
    listUserApps(user.id),
    todaysAttendance(user.id),
  ]);
  /* PUNCHING IN IS HERE, NOT IN THE HRMS (Nov 2026): the launcher is where
     everybody lands after signing in. The day card is the workday clock's,
     shown to whoever holds the HRMS — everybody whose day is recorded there. */
  const checkIn = ids.includes("hrms");

  const locked = lockedApps(ids);
  const waiting = apps.filter((a) => a.count > 0);
  const pending = waiting.reduce((n, a) => n + a.count, 0);

  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <WorkdayProvider>
    <div className="animate-fade-in flex min-h-screen flex-col bg-canvas">
      {apps.length > 1 ? (
        <AppShortcuts hrefs={apps.map((a) => a.href)} />
      ) : null}

      <header className="relative z-2 flex min-h-[60px] flex-none flex-wrap items-center gap-3 border-b border-brand-softer bg-brand-soft px-7 py-2">
        <Wordmark />
        <span className="flex-1" />
        <WorkdayChip />
        <FeedbackButton />
        {/*
          THE ONE PLACE THE ACCOUNT'S OWN LEVEL IS THE RIGHT ANSWER.
          Everywhere else the designation is the level for the app somebody is
          standing in; the launcher is not an app, so there is no hat to
          resolve and the widest level held anywhere is exactly what this
          screen is about. The hover says so rather than letting a reader carry
          "Admin" into an app where they are an associate.
        */}
        <AccountMenu
          user={user}
          hat={{
            label: levelLabel(user.role),
            sentence: `${levelLabel(user.role)} on your account — the widest level you hold. Inside an app it may be lower.`,
          }}
          variant="header"
        />
      </header>

      {/* THE LAUNCHER IS THE WORKDAY CLOCK DESIGN'S (Nov 2026): a greeting,
          the day card, and the apps as tiles with their counts. The dark hero
          and the separate "Waiting for you" strip went with it — each tile
          carries its own count and line. */}
      <div className="flex-1 px-6 pt-10 pb-12">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-6">
          <div>
            <h1 className="m-0 text-[28px] leading-9 font-bold text-ink">
              {greeting}, {user.name.split(" ")[0]}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {longDate(today())}
              {attendance ? ` · signed in at ${clock(attendance.signedInAt)}` : ""}
              {pending ? ` · ${pending} waiting across ${waiting.length} ${waiting.length === 1 ? "app" : "apps"}` : ""}
            </p>
          </div>

          {checkIn ? <LauncherCheckIn /> : null}

          {apps.length > 1 ? (
            <div className="-mb-3 text-right text-[13px] text-muted">
              Press 1–{apps.length} to open an app
            </div>
          ) : null}

          {apps.length ? (
            <CardGrid min={220}>
              {apps.map((app, i) => (
                <Link
                  key={app.id}
                  href={app.href}
                  title={apps.length > 1 ? `Press ${i + 1} to open ${app.name}` : undefined}
                  className="flex min-h-[132px] flex-col gap-3 rounded-[14px] border border-line bg-surface p-[18px] text-ink no-underline transition-colors duration-100 hover:border-brand hover:no-underline"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span
                      className={cx(
                        "flex size-10 flex-none items-center justify-center rounded-[10px] text-[15px] font-bold",
                        app.tone === "primary" ? "bg-brand text-white" : "bg-brand-soft text-brand-deep",
                      )}
                    >
                      {app.initials}
                    </span>
                    {app.count > 0 ? (
                      <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[12px] font-bold text-brand-deep">
                        {app.count}
                      </span>
                    ) : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-bold">{app.name}</span>
                    <span className={cx("block text-[13px] leading-[18px]", app.count ? "text-warn-ink" : "text-muted")}>
                      {app.count ? app.status : app.description}
                    </span>
                  </span>
                </Link>
              ))}
            </CardGrid>
          ) : (
            <div className="rounded-[6px] border border-line bg-surface px-6 py-14 text-center">
              <div className="text-lg font-semibold text-ink">
                No apps on your account yet
              </div>
              <p className="mx-auto mt-1.5 max-w-[420px] text-[15px] text-muted">
                Your sign-in works - a manager just has not given you an app to
                open. Ask them to add you in the Admin Console.
              </p>
            </div>
          )}

          {locked.length ? (
            <>
              <div className="mt-9 mb-3.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                Not on your account
              </div>
              <div className="flex flex-wrap gap-2.5">
                {locked.map((app) => (
                  <span
                    key={app.id}
                    className="inline-flex h-8.5 items-center gap-2 rounded-[4px] border border-divider bg-surface px-3"
                  >
                    <Icon
                      name="lock"
                      size={13}
                      strokeWidth={1.8}
                      className="flex-none text-line-strong"
                    />
                    <span className="text-[13px] whitespace-nowrap text-muted">
                      {app.name}
                    </span>
                  </span>
                ))}
              </div>
              <p className="mt-3 text-[13px] text-muted">
                Your manager controls which apps an account opens.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
    </WorkdayProvider>
  );
}
