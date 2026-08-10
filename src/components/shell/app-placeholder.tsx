import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { APPS, getApp, wordmark, type AppId } from "@/lib/apps";
import { Wordmark } from "./wordmark";
import { AppSwitcher } from "./app-switcher";
import { SignOutButton } from "./sign-out-button";

/**
 * The shell every MahekOne app sits in, standing in for the ones not built yet.
 * Sign-in, access control and the app switcher all work already — only the
 * app's own screens are missing, and the page says exactly that rather than
 * pretending to be broken. It does NOT claim attendance among them: a sign-in
 * log is not attendance, and the check-in system is not built either.
 */
export async function AppPlaceholder({ app: appId }: { app: AppId }) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes(appId)) redirect("/apps");

  const app = getApp(appId)!;
  const multi = apps.length > 1;

  return (
    <div className="animate-fade-in flex min-h-screen flex-col bg-canvas">
      <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-4">
        {multi ? (
          <AppSwitcher
            apps={APPS.filter((a) => apps.includes(a.id))}
            current={appId}
          />
        ) : null}
        <Wordmark label={wordmark(app)} />
        <span className="flex-1" />
        <span className="text-[13px] text-muted">
          {user.name} · {user.role}
        </span>
        <SignOutButton />
      </header>

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-[460px] text-center">
          <div className="text-[22px] leading-7 font-semibold text-ink">
            {app.name}
          </div>
          <p className="mt-2 text-[15px] leading-[22px] text-muted">
            Not built yet - this is where {app.name} will open. The sign-in,
            app access and the switcher already work, and it shares the same
            database as the CRM.
          </p>
          <div className="mt-5 flex justify-center gap-2.5">
            {multi ? (
              <Link
                href="/apps"
                className="flex h-9 items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
              >
                All apps
              </Link>
            ) : (
              <SignOutButton />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
