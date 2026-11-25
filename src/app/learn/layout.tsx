import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { myAssets } from "@/lib/hire/services/onboarding-records";
import { LearnNav } from "./learn-nav";

export const metadata: Metadata = { title: { template: "%s · Training · MahekOne", default: "Training · MahekOne" } };

/**
 * THE TRAINING APP (Onboarding & Training PRD §12–19), for the person being
 * trained. It is not an app grant: anybody signed in may open it, and every
 * screen shows only their own enrolments and assets — a new employee is given
 * it by being enrolled when Hire creates their account.
 *
 * Deliberately NOT `AppFrame`: that frame is the desk products' shell, with a
 * width floor below which it scrolls sideways. This is read on a phone — a
 * field salesman's — so it is a single column that fits 390px and simply
 * centres on a desk.
 */
export default async function LearnLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const waiting = (await myAssets(user.id)).filter((r) => !r.a.acknowledgedAt && !r.a.problem).length;
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-body">
      <header className="sticky top-0 z-20 flex h-14 flex-none items-center gap-2.5 border-b border-line bg-surface px-4">
        <Link href="/learn" className="flex items-center gap-2.5 no-underline hover:no-underline">
          <span className="flex size-7 items-center justify-center rounded-[6px] bg-brand text-[14px] font-bold text-brand-lime" aria-hidden="true">
            M
          </span>
          <span className="text-[13px] font-semibold tracking-[0.06em] text-heading">MAHEK TRAINING</span>
        </Link>
        <span className="flex-1" />
        <Link href="/apps" className="text-[13px] text-muted no-underline hover:text-body" title="Your MahekOne apps">
          Apps
        </Link>
        <span className="flex size-8 items-center justify-center rounded-full bg-divider text-[12px] font-semibold text-body" title={user.name}>
          {user.initials}
        </span>
      </header>
      <main className="mx-auto w-full max-w-[640px] flex-1 px-4 pt-4 pb-24">{children}</main>
      <LearnNav assetsWaiting={waiting} />
    </div>
  );
}
