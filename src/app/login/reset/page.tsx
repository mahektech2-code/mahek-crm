import Link from "next/link";
import { BrandPanel, BrandPanelHeading } from "@/components/shell/brand-panel";
import { Icon } from "@/components/shell/icons";
import { findLiveReset, RESET_TTL_MINUTES } from "@/lib/password-reset";
import { ResetForm } from "./reset-form";

export const metadata = { title: "Set a new password — MahekOne" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";
  // Checked before the form is drawn as well as when it is submitted: a dead
  // link should say so straight away rather than after a typed password.
  const live = await findLiveReset(token);

  return (
    <div className="animate-fade-in grid min-h-screen grid-cols-1 md:grid-cols-2">
      <BrandPanel
        footer={
          <p className="text-[13px] text-white/55">
            A link works once and expires {RESET_TTL_MINUTES} minutes after it
            was asked for.
          </p>
        }
      >
        <BrandPanelHeading eyebrow="Account access">
          Choose something you will not have to reset again next week.
        </BrandPanelHeading>
        <p className="animate-rise mt-3.5 text-[15px] leading-6 text-balance text-white/70 [animation-delay:80ms]">
          The new password takes effect immediately and ends every session the
          account already had — including on the phone you left signed in.
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

          {live ? (
            <>
              <h1 className="text-[22px] leading-7 font-semibold text-ink">
                Set a new password
              </h1>
              <p className="mt-1.5 text-sm leading-[21px] text-muted">
                This link works once. Once it is used it stops working.
              </p>
              <ResetForm token={token} />
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
                Reset links work once and last {RESET_TTL_MINUTES} minutes. Ask
                for a fresh one and it will arrive at the same address.
              </p>
              <Link
                href="/login/forgot"
                className="mt-5 inline-flex h-10 items-center rounded-[6px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:border-brand-hover hover:bg-brand-hover hover:no-underline"
              >
                Send a new link
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
