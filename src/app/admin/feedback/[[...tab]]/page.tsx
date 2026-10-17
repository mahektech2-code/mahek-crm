import { redirect } from "next/navigation";
import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { getConfig } from "@/lib/config/store";
import { feedbackCounts, listFeedback } from "@/lib/services/feedback-service";
import { AdminPage } from "../../_shell/admin-page";
import { adminContext, firstPageFor } from "../../_shell/context";
import { FeedbackSection } from "../../feedback-section";

export default async function FeedbackPage({ params }: { params: Promise<{ tab?: string[] }> }) {
  const ctx = await adminContext();
  if (!ctx.canTriage) redirect(firstPageFor(ctx));
  const [{ tab }, rows, counts, config] = await Promise.all([params, listFeedback(), feedbackCounts(), getConfig()]);
  const slug = ADMIN_TABS.feedback[tabIndexOf(ADMIN_TABS.feedback, tab?.[0])].slug;

  return (
    <AdminPage
      title="Feedback"
      subtitle="What the team has reported, asked for or suggested from inside the apps. Answering one tells the person who wrote it."
      tabs={{ items: ADMIN_TABS.feedback, active: slug, href: (s) => ADMIN.feedback(s as TabsOf<"feedback">) }}
    >
      <FeedbackSection
        tab={tabIndexOf(ADMIN_TABS.feedback, slug)}
        data={{
          rows,
          counts,
          // Answering is a manager's, or a platform admin's. A CRM manager on
          // this console reads what their own team reported.
          canTriage: ctx.canTriage,
          viewerId: ctx.user.id,
          maxImages: config["attachments.maxPerFeedback"],
        }}
      />
    </AdminPage>
  );
}
