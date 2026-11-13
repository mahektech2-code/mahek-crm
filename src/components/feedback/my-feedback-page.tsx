import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { listMyFeedback } from "@/lib/services/feedback-service";
import { markFeedbackRead } from "@/lib/actions/feedback";
import { MyFeedbackScreen } from "./my-feedback-screen";

/**
 * "Feedback" inside an app — what the signed-in person has sent in, from every
 * app, and what came back.
 *
 * One server component every app mounts at its own path (`FEEDBACK_APP_PATHS`),
 * inside its own frame: reading the answer used to be a page of its own outside
 * every app, with no header and no sidebar, which read as being thrown out of
 * MahekOne. The rows are only ever the signed-in person's, so the app's layout
 * having asked whether they hold the app is the whole gate.
 *
 * Opening one thread marks THAT thread read — the dot on the Feedback button
 * counts what is still unread elsewhere, and opening the page must not clear
 * replies nobody has looked at.
 */
export async function MyFeedbackPage({
  searchParams,
  className = "mx-auto w-full max-w-[1280px] px-6 pt-6 pb-10",
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  className?: string;
}) {
  const user = await requireUser();
  const [sp, config] = await Promise.all([searchParams, getConfig()]);
  const rows = await listMyFeedback(user.id);

  const asked = typeof sp.r === "string" ? sp.r : null;
  const tab = typeof sp.tab === "string" ? sp.tab : null;
  const selected = rows.find((r) => r.id === asked) ?? null;

  if (selected?.unread) await markFeedbackRead(selected.id);

  return (
    <div className={className}>
      <MyFeedbackScreen
        rows={rows}
        selectedId={selected?.id ?? null}
        tab={tab}
        viewerId={user.id}
        maxImages={config["attachments.maxPerFeedback"]}
      />
    </div>
  );
}
