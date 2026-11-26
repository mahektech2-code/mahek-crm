import Link from "next/link";
import { APP_TIMEZONE } from "@/lib/business-date";
import { requireUser } from "@/lib/auth";
import { launcherApps, launcherRoles, listUserApps } from "@/lib/access";
import { AccountMenu } from "@/components/shell/account-menu";
import { levelLabel } from "@/lib/hat-labels";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { cx } from "@/components/ui/primitives";
import { today } from "@/lib/format";
import { dayDate } from "@/components/workday/format";
import { AppShortcuts } from "./app-shortcuts";
import { CardGrid } from "@/components/ui/card-grid";
import { LauncherCheckIn } from "@/components/checkin/launcher-check-in";
import { WorkdayProvider } from "@/components/workday/workday-context";
import { WorkdayChip } from "@/components/workday/workday-chip";
import { ResumeAfterUnlock } from "@/components/workday/resume-after-unlock";
import { APP_ICON_PATH, GROUP_TONE, groupApps, groupOf, roleTone } from "@/lib/launcher-groups";
import type { AppId } from "@/lib/apps";
import { enrollmentView, enrollmentsForUser } from "@/lib/training/service";
import { nowMs } from "@/lib/format";
import "@/styles/v4-theme.css";

export const metadata = { title: "Your apps - MahekOne" };

/* ---------------------------------------------------------------------------
 * THE LAUNCHER (Nov 2026 redesign). Says only what somebody acts on: the day
 * card, what needs them today, and their apps — grouped onto four shelves,
 * each tile carrying the role this person holds in it and, only when work is
 * waiting, the count and what it is. The apps somebody does not hold are not
 * listed: that is the Access screen's question, not theirs.
 * ------------------------------------------------------------------------- */

const NEEDS_SHOWN = 4;
const SHELVES_FROM = 6;

const ROLE_BADGE: Record<ReturnType<typeof roleTone>, string> = {
  admin: "bg-ink text-white",
  manager: "bg-brand-soft text-brand-deep",
  associate: "bg-divider text-body",
};

function AppGlyph({ id, size, primary }: { id: AppId; size: "md" | "sm"; primary?: boolean }) {
  const tone = GROUP_TONE[groupOf(id)];
  const box = size === "md" ? "size-[46px] rounded-[12px]" : "size-10 rounded-[11px]";
  return (
    <span
      className={cx("flex flex-none items-center justify-center", box)}
      style={primary ? { background: "var(--color-brand)", color: "#ffffff" } : { background: tone.bg, color: tone.fg }}
    >
      <svg width={size === "md" ? 22 : 19} height={size === "md" ? 22 : 19} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={APP_ICON_PATH[id]} />
      </svg>
    </span>
  );
}

export default async function LauncherPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const user = await requireUser();
  const nextParam = (await searchParams).next;
  const next = typeof nextParam === "string" ? nextParam : null;
  const [apps, ids, roles, enrolments] = await Promise.all([launcherApps(user), listUserApps(user.id), launcherRoles(user.id), enrollmentsForUser(user.id)]);
  /* TRAINING IS NOT AN APP GRANT: somebody enrolled on a track is given the way in here. */
  const activeTraining = enrolments.find((e) => e.status === "active");
  const training = activeTraining ? await enrollmentView(activeTraining.id, nowMs()) : null;
  /* PUNCHING IN IS HERE: the launcher is where everybody lands after signing
     in, and the day card is the workday clock's, for whoever holds the HRMS. */
  const checkIn = ids.includes("hrms");

  /* Shelves only pay for themselves past a handful of apps: with six or fewer
     they are a heading per tile, so the tiles sit in one grid instead. */
  const shelved = groupApps(apps);
  const groups =
    apps.length > SHELVES_FROM || !shelved.length ? shelved : [{ ...shelved[0], apps: shelved.flatMap((g) => g.apps) }];
  const ordered = groups.flatMap((g) => g.apps);
  /* Only when work waits in more than one app: with one, its tile already says it. */
  const waiting = [...apps].filter((a) => a.count > 0).sort((a, b) => b.count - a.count);
  const needs = waiting.length > 1 ? waiting.slice(0, NEEDS_SHOWN) : [];

  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIMEZONE, hour: "numeric", hour12: false }).format(new Date()),
  );
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <WorkdayProvider>
      <ResumeAfterUnlock next={next} />
      <div data-v4 className="animate-fade-in flex min-h-screen flex-col bg-canvas">
        {ordered.length > 1 ? <AppShortcuts hrefs={ordered.map((a) => a.href)} /> : null}

        <header data-v4-header className="relative z-2 flex h-14 flex-none items-center gap-3 border-b border-brand-softer bg-brand-soft px-4">
          <Link href="/apps" title="MahekOne apps" className="flex items-center gap-2.5 no-underline hover:no-underline">
            {/* eslint-disable-next-line @next/next/no-img-element -- a 256px static mark, nothing for the optimiser to do */}
            <img src="/brand/mahek-logo.png" alt="Mahek" width={30} height={30} className="h-7.5 w-7.5 flex-none rounded-full bg-surface object-contain" />
            <span className="text-[16px] font-bold tracking-tight whitespace-nowrap text-ink">
              MahekOne <span className="font-medium text-faint">Apps</span>
            </span>
          </Link>
          <span className="flex-1" />
          <div className="flex flex-none items-center gap-2">
            <WorkdayChip />
            <FeedbackButton />
            <AccountMenu
              user={user}
              hat={{
                label: levelLabel(user.role),
                sentence: `${levelLabel(user.role)} on your account — the widest level you hold. Inside an app it may be lower.`,
              }}
              variant="header"
            />
          </div>
        </header>

        <div className="flex-1 px-6 pt-9 pb-14">
          <div className="mx-auto flex max-w-[1160px] flex-col gap-8">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-brand">{dayDate(today())}</span>
              <h1 className="m-0 text-[32px] leading-10 font-bold tracking-[-0.02em] text-ink">
                {greeting}, {user.name.split(" ")[0]}
              </h1>
            </div>

            {checkIn ? <LauncherCheckIn quiet /> : null}

            {training ? (
              <Link
                href="/learn"
                className="flex min-h-[72px] items-center gap-3.5 rounded-[16px] border border-brand-softer bg-brand-soft p-4 text-ink no-underline transition-colors hover:border-brand hover:no-underline"
              >
                <span className="flex size-[46px] flex-none items-center justify-center rounded-[12px] bg-brand text-white">
                  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 9l10-5 10 5-10 5zM6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6" />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[15px] font-bold tracking-[-0.01em]">Training · {training.track.title}</span>
                  <span className="truncate text-[13px] text-body">
                    {training.summary.passed} of {training.summary.required} modules passed
                    {training.modules.some((m) => m.state === "retraining_required") ? " · a module needs a retake" : training.summary.current ? ` · next: ${training.modules.find((m) => m.moduleKey === training.summary.current?.moduleKey)?.title ?? ""}` : ""}
                  </span>
                </span>
                <span className="text-[13px] font-semibold text-brand-hover">Open</span>
              </Link>
            ) : null}

            {needs.length ? (
              <section className="flex flex-col gap-3.5">
                <h2 className="m-0 text-[18px] font-bold text-ink">Needs you today</h2>
                <CardGrid min={220} fill>
                  {needs.map((app) => (
                    <Link
                      key={app.id}
                      href={app.href}
                      className="flex items-center gap-3.5 rounded-[14px] border border-line bg-surface px-[18px] py-4 text-ink no-underline transition-colors hover:border-brand hover:no-underline"
                    >
                      <AppGlyph id={app.id} size="sm" />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-[24px] leading-7 font-bold tracking-[-0.02em]">{app.count}</span>
                        <span className="truncate text-[13px] text-body" title={app.status}>
                          {app.name}
                        </span>
                      </span>
                    </Link>
                  ))}
                </CardGrid>
              </section>
            ) : null}

            {ordered.length ? (
              <section className="flex flex-col gap-5">
                <h2 className="m-0 text-[18px] font-bold text-ink">Your apps</h2>
                {groups.map((g) => (
                  <div key={g.id} className="flex flex-col gap-3">
                    {groups.length > 1 ? (
                      <span className="flex items-center gap-2 text-[13px] font-bold text-body">
                        <span className="size-2 rounded-[2px]" style={{ background: GROUP_TONE[g.id].dot }} />
                        {g.title}
                      </span>
                    ) : null}
                    <CardGrid min={260} fill>
                      {g.apps.map((app) => {
                        const i = ordered.indexOf(app);
                        const role = roles[app.id];
                        return (
                          <Link
                            key={app.id}
                            href={app.href}
                            title={ordered.length > 1 && i < 9 ? `Press ${i + 1} to open ${app.name}` : undefined}
                            className="flex min-h-[84px] items-center gap-3.5 rounded-[16px] border border-line bg-surface p-4 text-ink no-underline transition-[border-color,box-shadow] duration-100 hover:border-brand hover:no-underline hover:shadow-[0_6px_20px_rgba(61,20,168,0.10)]"
                          >
                            <AppGlyph id={app.id} size="md" primary={app.tone === "primary"} />
                            <span className="flex min-w-0 flex-1 flex-col gap-1">
                              <span className="truncate text-[15px] font-bold tracking-[-0.01em]">{app.name}</span>
                              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                {role ? (
                                  <span className={cx("inline-flex h-5 items-center rounded-[5px] px-1.5 text-[11px] font-semibold", ROLE_BADGE[roleTone(role)])}>
                                    {role}
                                  </span>
                                ) : null}
                                {app.count > 0 ? (
                                  <span className="truncate text-[13px] font-medium text-warn-ink">{app.status}</span>
                                ) : null}
                              </span>
                            </span>
                            {app.count > 0 ? (
                              <span className="flex h-6 min-w-[26px] flex-none items-center justify-center rounded-full bg-brand px-2 text-[12px] font-bold text-white">
                                {app.count}
                              </span>
                            ) : null}
                          </Link>
                        );
                      })}
                    </CardGrid>
                  </div>
                ))}
              </section>
            ) : (
              <div className="rounded-[16px] border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
                <div className="text-lg font-semibold text-ink">No apps on your account yet</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </WorkdayProvider>
  );
}
