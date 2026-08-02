import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { getApp, wordmark, type AppId } from "@/lib/apps";
import { Wordmark } from "./wordmark";
import { Icon } from "./icons";
import { SignOutButton } from "./sign-out-button";

/**
 * The shell every MahekOne app sits in, standing in for the ones not built yet.
 * Sign-in, access control, attendance and the app switcher all work already —
 * only the app's own screens are missing, and the page says exactly that rather
 * than pretending to be broken.
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
          <Link
            href="/apps"
            title="Switch app"
            aria-label="Switch app"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[4px] border border-line bg-surface text-muted no-underline hover:bg-canvas hover:text-body hover:no-underline"
          >
            <Icon name="grid" size={16} />
          </Link>
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
            Not built yet — this is where {app.name} will open. The sign-in,
            app access, attendance and the switcher already work, and it shares
            the same database as the CRM.
          </p>
          <div className="mt-5 flex justify-center gap-2.5">
            {multi ? (
              <Link
                href="/apps"
                className="flex h-9 items-center rounded-[4px] border border-line-strong bg-surface px-4 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Switch app
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
