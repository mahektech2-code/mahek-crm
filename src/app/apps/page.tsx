import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { launcherApps, listUserApps, lockedApps, todaysAttendance } from "@/lib/access";
import { Wordmark } from "@/components/shell/wordmark";
import { AppChip } from "@/components/shell/app-chip";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { cx } from "@/components/ui/primitives";
import { clock, longDate, today } from "@/lib/format";

export const metadata = { title: "Your apps — MahekOne" };

export default async function LauncherPage() {
  const user = await requireUser();
  const [apps, ids, attendance] = await Promise.all([
    launcherApps(user),
    listUserApps(user.id),
    todaysAttendance(user.id),
  ]);

  const locked = lockedApps(ids);
  const waiting = apps.filter((a) => a.count > 0);
  const primary = waiting.slice().sort((a, b) => b.count - a.count)[0];

  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="animate-fade-in flex min-h-screen flex-col bg-canvas">
      <header className="flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-6">
        <Wordmark />
        <span className="flex-1" />
        <span className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
            {user.initials}
          </span>
          <span className="leading-[14px]">
            <span className="block text-[13px] font-medium text-ink">
              {user.name}
            </span>
            <span className="block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              {user.role}
            </span>
          </span>
        </span>
        <SignOutButton />
      </header>

      <div className="flex-1 px-6 pt-8 pb-12">
        <div className="mx-auto max-w-[1000px]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[28px] leading-[34px] font-semibold text-ink">
                {greeting}, {user.name.split(" ")[0]}
              </h1>
              <p className="mt-1 text-sm text-muted">
                {longDate(today())} · you have access to {apps.length}{" "}
                {apps.length === 1 ? "app" : "apps"}
              </p>
            </div>
            {attendance ? (
              <div className="text-right">
                <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
                  Signed in at
                </div>
                <div className="text-sm font-medium text-ink">
                  {clock(attendance.signedInAt)} · attendance recorded
                </div>
              </div>
            ) : null}
          </div>

          {primary ? (
            <div className="mt-5 flex items-center gap-3 rounded-[4px] border border-warn-line border-l-[3px] border-l-warn bg-warn-soft px-4 py-3">
              <span className="text-sm font-medium whitespace-nowrap text-warn-ink">
                Waiting for you
              </span>
              <span className="min-w-0 truncate text-sm text-body">
                {waiting.map((a) => `${a.count} in ${a.name}`).join(" · ")}
              </span>
              <span className="flex-1" />
              <Link
                href={primary.href}
                className="flex h-7.5 flex-none items-center rounded-[4px] border border-brand bg-brand px-3 text-[13px] font-medium text-white no-underline hover:bg-brand-hover hover:no-underline"
              >
                Open {primary.name}
              </Link>
            </div>
          ) : null}

          <div className="mt-7 mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            Your apps
          </div>

          {apps.length ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {apps.map((app) => (
                <Link
                  key={app.id}
                  href={app.href}
                  className="block rounded-[6px] border border-line bg-surface p-4 no-underline transition-colors duration-100 hover:border-line-strong hover:no-underline"
                >
                  <span className="flex items-start justify-between gap-3">
                    <AppChip app={app} />
                    {app.count > 0 ? (
                      <span className="flex h-5 min-w-[22px] items-center justify-center rounded-[10px] bg-danger-soft px-1.5 text-[11px] font-medium text-danger">
                        {app.count}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-3.5 block text-base font-semibold text-ink">
                    {app.name}
                  </span>
                  <span className="mt-1 block text-[13px] leading-[19px] text-muted">
                    {app.description}
                  </span>
                  <span className="mt-3.5 flex items-center justify-between gap-3 border-t border-divider pt-3">
                    <span
                      className={cx(
                        "min-w-0 truncate text-[13px]",
                        app.count ? "text-warn-ink" : "text-muted",
                      )}
                    >
                      {app.status}
                    </span>
                    <span className="flex-none text-[13px] font-medium whitespace-nowrap text-brand">
                      Open →
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-[6px] border border-line bg-surface px-6 py-14 text-center">
              <div className="text-lg font-semibold text-ink">
                No apps on your account yet
              </div>
              <p className="mx-auto mt-1.5 max-w-[420px] text-[15px] text-muted">
                Your sign-in works — a manager just has not given you an app to
                open. Ask them to add you in the Admin Console.
              </p>
            </div>
          )}

          {locked.length ? (
            <>
              <div className="mt-8 mb-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                Not on your account
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {locked.map((app) => (
                  <div
                    key={app.id}
                    className="rounded-[6px] border border-divider bg-surface p-4 opacity-55"
                  >
                    <span className="flex items-center gap-2.5">
                      <AppChip app={{ ...app, tone: "neutral" }} />
                      <span className="text-sm font-medium text-ink">
                        {app.name}
                      </span>
                    </span>
                    <span className="mt-2.5 block text-[13px] text-muted">
                      🔒 Ask your manager for access
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
