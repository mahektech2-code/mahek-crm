import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { getApp, APPS } from "@/lib/apps";
import {
  BrandPanel,
  BrandPanelHeading,
  BrandUnderline,
} from "@/components/shell/brand-panel";
import { Icon } from "@/components/shell/icons";
import { longDate, today } from "@/lib/format";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in - MahekOne" };

/** Why the suite exists — written for the whole team, not one role. */
const WHY = [
  {
    title: "One record per customer",
    body: "Whoever picks up the account reads the same history, whichever tool they work in.",
  },
  {
    title: "Nothing chased twice",
    body: "A message, a promise or a visit logged once is visible to everyone who needs it.",
  },
  {
    title: "The day already ordered",
    body: "Each tool opens on the work that matters most, so nobody decides where to start.",
  },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  const justReset = (await searchParams).reset === "1";
  const user = await getCurrentUser();
  if (user) {
    const apps = await listUserApps(user.id);
    redirect(apps.length === 1 ? (getApp(apps[0])?.href ?? "/apps") : "/apps");
  }

  return (
    <div className="animate-fade-in grid min-h-screen grid-cols-1 md:grid-cols-2">
      <BrandPanel
        footer={
          <div className="flex flex-wrap gap-2">
            {APPS.map((app, i) => (
              <span
                key={app.id}
                style={{ animationDelay: `${1600 + i * 90}ms` }}
                className="animate-rise inline-flex h-6.5 items-center rounded-[4px] border border-white/20 px-2.5 text-xs whitespace-nowrap text-white/75"
              >
                {app.name}
              </span>
            ))}
          </div>
        }
      >
        <BrandPanelHeading eyebrow="One workspace">
          Every tool the Mahek team works in, behind{" "}
          <BrandUnderline>one sign-in</BrandUnderline>.
        </BrandPanelHeading>
        <p className="animate-rise mt-3.5 text-[15px] leading-6 text-balance text-white/70 [animation-delay:80ms]">
          Calling, collections, orders, dispatch and targets were separate
          books and separate WhatsApp threads. MahekOne puts them in one
          place so a customer&rsquo;s history follows them wherever the work
          happens.
        </p>

        <div className="mt-8 flex flex-col gap-3.5">
          {WHY.map((point, i) => (
            <div
              key={point.title}
              style={{ animationDelay: `${900 + i * 220}ms` }}
              className="animate-slide-in-left flex items-start gap-3"
            >
              <span
                style={{ animationDelay: `${i * 500}ms` }}
                className="animate-float mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-[4px] bg-brand-lime/15 text-brand-lime"
              >
                <Icon name="tick" size={12} strokeWidth={2.4} />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-medium text-white">
                  {point.title}
                </span>
                <span className="mt-0.5 block text-sm leading-[21px] text-white/65">
                  {point.body}
                </span>
              </span>
            </div>
          ))}
        </div>
      </BrandPanel>

      <div className="flex min-w-0 items-center justify-center bg-canvas px-6 py-12">
        <div className="animate-slide-in w-full max-w-[420px]">
          <div className="text-[11px] font-medium tracking-[0.04em] text-brand uppercase">
            {longDate(today())}
          </div>
          <h1 className="mt-2.5 text-[26px] leading-[34px] font-semibold text-ink">
            Welcome back
          </h1>
          <p className="mt-1 text-[15px] leading-[23px] text-muted">
            Enter your work number and we&rsquo;ll send you a code. One
            sign-in opens every app on your account.
          </p>

          {justReset ? (
            <div className="mt-4 rounded-[4px] border border-success-soft border-l-[3px] border-l-success bg-success-soft px-3 py-2.5 text-sm text-ink">
              The field app&rsquo;s password is set. Signing in here still
              only needs your work number and a code.
            </div>
          ) : null}

          <LoginForm />

          <div className="mt-5 flex items-center gap-2.5">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs whitespace-nowrap text-muted">
              Accounts are created by your manager
            </span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <p className="mt-3 text-center text-[13px] leading-5 text-muted">
            You see only the tools your role uses. No account?{" "}
            <span className="font-medium text-ink">Ask your manager.</span>
          </p>
          <p className="mt-2 text-center text-[13px] leading-5 text-muted">
            Setting up the field salesman app?{" "}
            <Link
              href="/login/forgot"
              className="font-medium text-brand no-underline hover:underline"
            >
              Manage its password
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
