import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { BrandPanel, BrandPanelHeading } from "@/components/shell/brand-panel";
import { Icon } from "@/components/shell/icons";
import { ForgotForm } from "./forgot-form";

export const metadata = { title: "Forgot password - MahekOne" };

export default async function ForgotPasswordPage() {
  // Somebody already signed in does not need a reset link to change anything.
  if (await getCurrentUser()) redirect("/apps");

  return (
    <div className="animate-fade-in grid min-h-screen grid-cols-1 md:grid-cols-2">
      <BrandPanel
        footer={
          <p className="text-[13px] text-white/55">
            Still locked out after the link expires? Your manager can reset it
            for you.
          </p>
        }
      >
        <BrandPanelHeading eyebrow="Field salesman app">
          Reset your field app password without waiting on anyone.
        </BrandPanelHeading>
        <p className="animate-rise mt-3.5 text-[15px] leading-6 text-balance text-white/70 [animation-delay:80ms]">
          This is the password the MBOS handset app pairs with — signing in
          here on the web only ever needs a code sent to your phone. Enter the
          work email your account was created with and we send a link to set a
          new one. Nobody - not even your manager - can see or send you an
          existing one.
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
          <ForgotForm />
        </div>
      </div>
    </div>
  );
}
