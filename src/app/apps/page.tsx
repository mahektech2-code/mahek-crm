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
import { SignOutButton } from "@/components/shell/sign-out-button";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { cx } from "@/components/ui/primitives";
import { clock, longDate, today } from "@/lib/format";
import { AppShortcuts } from "./app-shortcuts";

export const metadata = { title: "Your apps - MahekOne" };

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
    <div className="animate-fade-in flex min-h-screen flex-col bg-canvas">
      {apps.length > 1 ? (
        <AppShortcuts hrefs={apps.map((a) => a.href)} />
      ) : null}

      <header className="relative z-2 flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-8">
        <Wordmark />
        <span className="flex-1" />
        <span className="flex items-center gap-2.5">
          <span className="flex h-7.5 w-7.5 items-center justify-center rounded-[4px] bg-brand-soft text-xs font-semibold text-[#5223E0]">
            {user.initials}
          </span>
          <span className="leading-[15px]">
            <span className="block text-[13px] font-medium whitespace-nowrap text-ink">
              {user.name}
            </span>
            <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">
              {user.role}
            </span>
          </span>
        </span>
        <FeedbackButton />
        <SignOutButton />
      </header>

      <div className="relative overflow-hidden bg-brand-deep px-8 py-9">
        <span
          aria-hidden
          className="animate-drift pointer-events-none absolute -top-45 -right-30 h-105 w-105 rounded-full border border-white/10 [animation-duration:20s]"
        />
        <span
          aria-hidden
          className="animate-drift pointer-events-none absolute -bottom-55 right-30 h-75 w-75 rounded-full border border-white/8 [animation-direction:reverse] [animation-duration:26s]"
        />
        <div className="relative mx-auto flex max-w-[1120px] flex-wrap items-end justify-between gap-8">
          <div className="min-w-0">
            <div className="text-[11px] font-medium tracking-[0.04em] text-brand-lime uppercase">
              {longDate(today())}
            </div>
            <h1 className="mt-2.5 text-[32px] leading-10 font-semibold text-white">
              {greeting}, {user.name.split(" ")[0]}
            </h1>
            <p className="mt-1.5 text-[15px] leading-6 text-white/70">
              {apps.length === 1
                ? "One app on your account."
                : `You have access to ${apps.length} apps.`}
              {attendance
                ? ` Signed in at ${clock(attendance.signedInAt)} - attendance recorded for today.`
                : ""}
            </p>
          </div>

          <div className="flex flex-none gap-7">
            <HeroStat
              label="Apps on your account"
              value={String(apps.length)}
              sub={
                apps.length === 1 ? "Opens straight away" : "One sign-in for all"
              }
            />
            <HeroStat
              label="Needing attention"
              value={String(pending)}
              sub={
                waiting.length
                  ? `Across ${waiting.length} ${waiting.length === 1 ? "app" : "apps"}`
                  : "Nothing waiting"
              }
            />
          </div>
        </div>
      </div>

      <div className="flex-1 px-8 pt-7 pb-12">
        <div className="mx-auto max-w-[1120px]">
          {primary ? (
            <div className="flex items-center gap-4 rounded-[6px] border border-line bg-surface px-5 py-4 shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[4px] bg-warn-soft text-warn">
                <Icon name="clock" size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">
                  Waiting for you
                </span>
                <span className="mt-px block truncate text-sm text-muted">
                  {waiting.map((a) => `${a.count} in ${a.name}`).join(" · ")}
                </span>
              </span>
              <Link
                href={primary.href}
                className="flex h-9 flex-none items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium whitespace-nowrap text-white no-underline hover:border-brand-hover hover:bg-brand-hover hover:no-underline"
              >
                Open {primary.name}
              </Link>
            </div>
          ) : null}

          <div className="mt-8 mb-3.5 flex items-baseline justify-between gap-4">
            <span className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
              Your apps
            </span>
            {apps.length > 1 ? (
              <span className="text-[13px] text-muted">
                Press 1–{apps.length} to open an app
              </span>
            ) : null}
          </div>

          {apps.length ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
              {apps.map((app, i) => (
                <Link
                  key={app.id}
                  href={app.href}
                  className="block rounded-[6px] border border-line bg-surface p-5 no-underline shadow-[0_1px_2px_rgba(22,22,22,0.06)] transition-colors duration-100 hover:border-brand hover:no-underline"
                >
                  <span className="flex items-start gap-3.5">
                    <span
                      className={cx(
                        "flex h-9 w-9 flex-none items-center justify-center rounded-[6px] text-xs font-semibold tracking-[0.02em]",
                        app.tone === "primary"
                          ? "bg-brand text-white"
                          : "bg-divider text-body",
                      )}
                    >
                      {app.initials}
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-base font-semibold text-ink">
                          {app.name}
                        </span>
                        {app.count > 0 ? (
                          <span className="flex h-5 min-w-[22px] flex-none items-center justify-center rounded-[10px] bg-danger-soft px-1.5 text-[11px] font-medium text-danger">
                            {app.count}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.75 block text-[13px] leading-[19px] text-muted">
                        {app.description}
                      </span>
                    </span>
                    {apps.length > 1 ? (
                      <span
                        title={`Press ${i + 1} to open ${app.name}`}
                        className="flex h-5.5 w-5.5 flex-none items-center justify-center rounded-[4px] border border-line text-[11px] font-medium text-muted"
                      >
                        {i + 1}
                      </span>
                    ) : null}
                  </span>

                  <span className="mt-4 flex items-center justify-between gap-3 border-t border-divider pt-3.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={cx(
                          "h-1.5 w-1.5 flex-none rounded-full",
                          app.count ? "bg-warn" : "bg-line-strong",
                        )}
                      />
                      <span
                        className={cx(
                          "min-w-0 truncate text-[13px]",
                          app.count ? "text-warn-ink" : "text-muted",
                        )}
                      >
                        {app.status}
                      </span>
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
  );
}

function HeroStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <span className="block">
      <span className="block text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-white/55 uppercase">
        {label}
      </span>
      <span className="mt-0.5 block text-[28px] leading-9 font-semibold text-white">
        {value}
      </span>
      <span className="block text-[13px] whitespace-nowrap text-white/65">
        {sub}
      </span>
    </span>
  );
}
