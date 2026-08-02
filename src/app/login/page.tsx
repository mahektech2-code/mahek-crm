import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { getApp, APPS } from "@/lib/apps";
import { Wordmark } from "@/components/shell/wordmark";
import { AppChip } from "@/components/shell/app-chip";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in — MahekOne" };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    const apps = await listUserApps(user.id);
    redirect(apps.length === 1 ? (getApp(apps[0])?.href ?? "/apps") : "/apps");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="animate-fade-in grid w-[840px] max-w-full grid-cols-1 overflow-hidden rounded-[6px] border border-line bg-surface md:grid-cols-[1fr_380px]">
        <div className="border-divider p-10 md:border-r">
          <Wordmark size="lg" />
          <p className="mt-1.5 text-[13px] text-muted">
            Mahek Marketing India · paint thinners and solvents
          </p>

          <h1 className="mt-8 text-[28px] leading-[34px] font-semibold text-ink">
            Sign in
          </h1>
          <p className="mt-1 text-sm text-muted">
            Use the work number or email your manager set up for you.
          </p>

          <LoginForm />
        </div>

        <div className="bg-canvas px-8 py-10">
          <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">
            What you get access to
          </div>
          <p className="mt-2 text-sm leading-[21px] text-body">
            One sign-in for every Mahek tool. You only see the apps your role
            uses.
          </p>

          <div className="mt-5 flex flex-col gap-2.5">
            {APPS.map((app) => (
              <div key={app.id} className="flex items-center gap-2.5">
                <AppChip app={app} />
                <span className="text-sm text-body">{app.name}</span>
              </div>
            ))}
          </div>

          <p className="mt-6 border-t border-line pt-4 text-[13px] leading-[19px] text-muted">
            Signing in records your attendance for the day. Sign out when you
            finish so your hours are right.
          </p>
        </div>
      </div>
    </div>
  );
}
