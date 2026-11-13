import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { FEEDBACK_APP_PATHS, type FeedbackApp } from "@/lib/feedback-labels";
import { Wordmark } from "@/components/shell/wordmark";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { MyFeedbackPage } from "@/components/feedback/my-feedback-page";

/* ---------------------------------------------------------------------------
 * `/feedback` — the address every feedback notification carries.
 *
 * It no longer draws the conversation on a page of its own: reading the answer
 * outside every app, with no header and no sidebar, read as having been thrown
 * out of MahekOne. It forwards — `?r=` and all — to the Feedback page of an app
 * this person holds, in the order they are most likely to be working in.
 *
 * A notification's link has to work from any app's bell, which is why the
 * address names no app; the forward is what puts it inside one.
 *
 * Somebody who holds none of those apps (Hire, Website, the Documentation app
 * alone) still reads it here, in a plain frame — there is no app to put it in.
 * ------------------------------------------------------------------------- */

export const metadata = { title: "Your feedback - MahekOne" };

const ORDER: FeedbackApp[] = ["crm", "accounts", "erp", "sales", "hrms", "founder"];

export default async function FeedbackForwardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [sp, apps] = await Promise.all([searchParams, listUserApps(user.id)]);
  const home = ORDER.find((a) => apps.includes(a));

  if (home) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
    const qs = q.toString();
    redirect(`${FEEDBACK_APP_PATHS[home]}${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="animate-fade-in flex min-h-screen flex-col bg-canvas">
      <header className="flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-6">
        <Wordmark label="Feedback" />
        <span className="flex-1" />
        <Link href="/apps" className="text-[13px] font-medium text-brand">
          Back to your apps
        </Link>
        <FeedbackButton />
      </header>
      <MyFeedbackPage searchParams={Promise.resolve(sp)} />
    </div>
  );
}
