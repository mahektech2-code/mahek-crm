import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { BrandPanel, BrandPanelHeading } from "@/components/shell/brand-panel";
import { Icon } from "@/components/shell/icons";
import { findLiveImpersonation, IMPERSONATION_TTL_MINUTES } from "@/lib/impersonation";
import { ImpersonateConfirmForm } from "./confirm-form";

export const metadata = { title: "Sign in as - MahekOne" };

/**
 * Loading this page never signs anybody in on its own — it only reads
 * whether the token is live and, if so, shows who it belongs to. The actual
 * sign-in needs the explicit "Continue as ..." press below, which is what
 * keeps a link scanner or a chat app's own link-preview fetch from quietly
 * burning a single-use token before the person it was minted for ever opens
 * it themselves.
 */
export default async function ImpersonatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const live = await findLiveImpersonation(token);
  const user = live
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, live.userId)).limit(1))[0]
    : null;

  return (
    <div className="animate-fade-in grid min-h-screen grid-cols-1 md:grid-cols-2">
      <BrandPanel
        footer={
          <p className="text-[13px] text-white/55">
            A sign-in link works once and expires {IMPERSONATION_TTL_MINUTES} minutes after
            it was generated.
          </p>
        }
      >
        <BrandPanelHeading eyebrow="Admin tool">
          Opening this replaces whatever account this browser is signed into.
        </BrandPanelHeading>
        <p className="animate-rise mt-3.5 text-[15px] leading-6 text-balance text-white/70 [animation-delay:80ms]">
          Nothing about the other account changes — no password, no session
          anywhere else. It is recorded who generated this link and when it
          was used.
        </p>
      </BrandPanel>

      <div className="flex min-w-0 items-center justify-center bg-canvas px-6 py-12">
        <div className="animate-slide-in w-full max-w-[400px]">
          <Link
            href="/login"
            className="mb-4.5 inline-flex items-center gap-1.5 text-sm text-muted no-underline hover:text-body hover:no-underline"
          >
            <Icon name="chevronLeft" size={14} />
            Back to sign in
          </Link>

          {live && user ? (
            <>
              <h1 className="text-[22px] leading-7 font-semibold text-ink">
                Sign in as {user.name}
              </h1>
              <p className="mt-1.5 text-sm leading-[21px] text-muted">
                This link works once. Continuing signs this browser out of
                whatever account it currently holds.
              </p>
              <ImpersonateConfirmForm token={token} userName={user.name} />
            </>
          ) : (
            <>
              <div className="flex h-11 w-11 items-center justify-center rounded-[6px] bg-warn-soft text-warn">
                <Icon name="alert" size={22} strokeWidth={1.8} />
              </div>
              <h1 className="mt-4 text-[22px] leading-7 font-semibold text-ink">
                That link has expired
              </h1>
              <p className="mt-2 text-[15px] leading-6 text-body">
                Sign-in links work once and last {IMPERSONATION_TTL_MINUTES} minutes. Ask
                an admin to generate a fresh one from the People screen.
              </p>
              <Link
                href="/login"
                className="mt-5 inline-flex h-10 items-center rounded-[6px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:border-brand-hover hover:bg-brand-hover hover:no-underline"
              >
                Back to sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
