import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandPanel, BrandPanelHeading } from "@/components/shell/brand-panel";
import { Icon } from "@/components/shell/icons";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { ConsoleConfirmForm } from "./confirm-form";

export const metadata = { title: "Confirm your password - MahekOne" };

/**
 * Where the Admin Console sends a session that has not proved its password
 * recently. See `lib/console-confirm.ts` for why it asks at all.
 */
export default async function ConsoleConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await requireUser();
  const { next } = await searchParams;
  const minutes = Number((await getConfig())["auth.console.confirmMinutes"]);
  // Switched off: a bookmark or a stale link to this page has nothing to ask.
  if (minutes === 0) redirect(/^\/admin(\/[\w\-/.%]*)?$/.test(next ?? "") ? next! : "/admin");

  return (
    <div className="animate-fade-in grid min-h-screen grid-cols-1 md:grid-cols-2">
      <BrandPanel
        footer={
          <p className="text-[13px] text-white/55">
            After {minutes} minutes away from the console it asks again. The rest of MahekOne stays signed in.
          </p>
        }
      >
        <BrandPanelHeading eyebrow="Admin Console">
          The console can change what anybody can reach, so it checks it is you.
        </BrandPanelHeading>
      </BrandPanel>

      <div className="flex min-w-0 items-center justify-center bg-canvas px-6 py-12">
        <div className="animate-slide-in w-full max-w-[400px]">
          <Link
            href="/apps"
            className="mb-4.5 inline-flex items-center gap-1.5 text-sm text-muted no-underline hover:text-body hover:no-underline"
          >
            <Icon name="chevronLeft" size={14} />
            Back to your apps
          </Link>
          <h1 className="text-[22px] leading-7 font-semibold text-ink">Confirm your password</h1>
          <p className="mt-1.5 text-sm leading-[21px] text-muted">
            Signed in as {user.name}. Type your password to open the Admin Console.
          </p>
          <ConsoleConfirmForm next={next ?? "/admin"} />
          <p className="mt-3.5 text-[13px] leading-5 text-muted">
            Forgotten it?{" "}
            <Link href="/login/forgot" className="text-brand">
              Reset your password
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
