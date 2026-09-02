import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { listMyFeedback } from "@/lib/services/feedback-service";
import { markFeedbackRead } from "@/lib/actions/feedback";
import { Wordmark } from "@/components/shell/wordmark";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { Badge, Card, EmptyState, type Tone } from "@/components/ui/primitives";
import { FeedbackThread } from "@/components/feedback/feedback-thread";
import { stamp } from "@/lib/format";
import { KIND_SHORT, STATUS_LABELS, type FeedbackStatus } from "@/lib/feedback-labels";

/* ---------------------------------------------------------------------------
 * "Your feedback" — where the person who reported something reads the answer.
 *
 * It sits outside the apps, beside the launcher, because feedback is not the
 * CRM's or Accounts' — a telecaller and an accounts clerk report the same
 * kinds of thing and both need somewhere to read the reply. Every notification
 * about a report links here, which is the point: a bell saying "somebody
 * answered" with nowhere to go and read the answer is the shape this had
 * before.
 *
 * Opening it marks the threads read, which is what clears the dot on the
 * Feedback button.
 * ------------------------------------------------------------------------- */

export const metadata = { title: "Your feedback - MahekOne" };

const STATUS_TONE: Record<FeedbackStatus, Tone> = {
  new: "warn",
  in_progress: "brand",
  done: "success",
  declined: "neutral",
};

export default async function MyFeedbackPage() {
  const user = await requireUser();
  const [reports, config] = await Promise.all([listMyFeedback(user.id), getConfig()]);

  // Reading them IS reading them. Done here rather than by a button, because
  // the only person who could press it has already read the thing.
  await markFeedbackRead();

  return (
    <div className="animate-fade-in flex min-h-screen flex-col bg-canvas">
      <header className="flex h-14 flex-none items-center gap-4 border-b border-line bg-surface px-8">
        <Wordmark label="Your feedback" />
        <span className="flex-1" />
        <Link
          href="/apps"
          className="text-[13px] font-medium text-brand"
        >
          Back to your apps
        </Link>
        <FeedbackButton />
      </header>

      <div className="flex-1 px-8 py-7">
        <div className="mx-auto max-w-[880px]">
          <h1 className="text-[22px] leading-7 font-semibold text-ink">
            What you have sent in
          </h1>
          <p className="mt-1.5 text-[15px] leading-6 text-muted">
            Everything you reported, asked for or suggested, and what came back.
            You can add to any of them — a screenshot or a second sentence is
            often what makes a fault findable.
          </p>

          {reports.length === 0 ? (
            <Card className="mt-5">
              <EmptyState
                title="You have not sent anything in yet"
                body="The Feedback button sits in the header of every app. Anything you send from it appears here, with the reply."
              />
            </Card>
          ) : (
            <div className="mt-5 flex flex-col gap-3">
              {reports.map((r) => (
                <Card key={r.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{KIND_SHORT[r.kind]}</Badge>
                    <Badge tone={STATUS_TONE[r.status]}>
                      {STATUS_LABELS[r.status]}
                    </Badge>
                    <span className="text-sm font-medium text-ink">{r.title}</span>
                    <span className="text-[13px] text-muted">
                      · sent {stamp(r.createdAt)}
                    </span>
                  </div>

                  <div className="mt-3">
                    <FeedbackThread
                      report={r}
                      viewerId={user.id}
                      maxImages={config["attachments.maxPerFeedback"]}
                    />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
