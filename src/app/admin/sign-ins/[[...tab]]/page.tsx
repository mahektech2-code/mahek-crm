import { ADMIN_TABS, SECURITY_TABS, tabIndexOf } from "@/lib/admin-routes";
import { liveSessions, onboardingRows } from "@/lib/services/admin-platform-service";
import { AdminPage, routeTabs } from "../../_shell/admin-page";
import { requirePlatformAdmin } from "../../_shell/context";
import { OnboardingTab, SessionsTab } from "../../platform-real";

/**
 * Two questions about signing in rather than about access: who is signed in
 * right now, and which accounts nobody has ever used. They were the last two
 * tabs of Overview, eight tabs along from anything to do with people.
 */
export default async function SignInsPage({ params }: { params: Promise<{ tab?: string[] }> }) {
  await requirePlatformAdmin();
  const { tab } = await params;
  const slug = ADMIN_TABS.signIns[tabIndexOf(ADMIN_TABS.signIns, tab?.[0])].slug;
  return (
    <AdminPage
      title="Security & sign-ins"
      subtitle="Who is signed in right now, and the accounts that have been created but never used."
      tabs={routeTabs(SECURITY_TABS, slug)}
    >
      {slug === "now" ? (
        <SessionsTab data={{ sessions: await liveSessions() }} />
      ) : (
        <OnboardingTab data={{ onboarding: await onboardingRows() }} />
      )}
    </AdminPage>
  );
}
