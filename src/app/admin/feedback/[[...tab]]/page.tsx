import { redirect } from "next/navigation";
import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import {
  feedbackAssignees,
  feedbackCounts,
  feedbackOverview,
  getFeedback,
  listFeedback,
} from "@/lib/services/feedback-service";
import {
  FEEDBACK_IMPACTS,
  FEEDBACK_KINDS,
  type FeedbackImpact,
  type FeedbackKind,
  type TriageQueue,
} from "@/lib/feedback-labels";
import { AdminPage } from "../../_shell/admin-page";
import { adminContext, firstPageFor } from "../../_shell/context";
import { FeedbackOverviewScreen, FeedbackSection } from "../../feedback-section";

/**
 * The console's Feedback: the triage inbox, one tab per queue, and an
 * Overview. Filters, the open report and the search ride in the URL, so a
 * notification can open one report directly (`?r=`) and the back button works.
 */
export default async function FeedbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await adminContext();
  if (!ctx.canTriage) redirect(firstPageFor(ctx));
  const [{ tab }, sp, counts, config] = await Promise.all([params, searchParams, feedbackCounts(), getConfig()]);
  const slug = ADMIN_TABS.feedback[tabIndexOf(ADMIN_TABS.feedback, tab?.[0])].slug as TabsOf<"feedback">;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const items = ADMIN_TABS.feedback.map((t) => {
    const n = t.slug === "all" ? counts.total : t.slug === "overview" ? null : counts[t.slug as keyof typeof counts];
    return { slug: t.slug, label: n === null || n === undefined ? t.label : `${t.label} · ${n}` };
  });
  const tabs = { items, active: slug, href: (s: string) => ADMIN.feedback(s as TabsOf<"feedback">) };

  if (slug === "overview") {
    const period = one("p") === "90" ? 90 : 30;
    return (
      <AdminPage title="Feedback" tabs={tabs}>
        <FeedbackOverviewScreen overview={await feedbackOverview(period)} />
      </AdminPage>
    );
  }

  const kind = FEEDBACK_KINDS.includes(one("kind") as FeedbackKind) ? (one("kind") as FeedbackKind) : undefined;
  const impact = FEEDBACK_IMPACTS.includes(one("impact") as FeedbackImpact) ? (one("impact") as FeedbackImpact) : undefined;
  const who = one("who");
  const [rows, assignees] = await Promise.all([
    listFeedback({
      queue: slug as TriageQueue,
      app: one("app"),
      kind,
      impact,
      assignee: who === "me" ? ctx.user.id : who === "mine-or-none" ? "mine-or-none" : who,
      viewerId: ctx.user.id,
      q: one("q"),
    }),
    feedbackAssignees(),
  ]);

  // The report asked for — from a notification, say — even when the filters
  // or the queue would not list it, and always the report a "same problem"
  // points at rather than the one that points.
  const asked = one("r");
  let selected = asked ? (rows.find((r) => r.id === asked) ?? null) : (rows[0] ?? null);
  if (asked && !selected) {
    const hit = await getFeedback(asked);
    selected = hit?.duplicateOfId ? await getFeedback(hit.duplicateOfId) : hit;
  }

  return (
    <AdminPage title="Feedback" tabs={tabs}>
      <FeedbackSection
        rows={rows}
        selected={selected}
        filters={{ app: one("app") ?? "", kind: kind ?? "", impact: impact ?? "", who: who ?? "", q: one("q") ?? "" }}
        assignees={assignees}
        viewerId={ctx.user.id}
        maxImages={config["attachments.maxPerFeedback"]}
        queue={slug as TriageQueue}
        now={nowMs()}
      />
    </AdminPage>
  );
}
