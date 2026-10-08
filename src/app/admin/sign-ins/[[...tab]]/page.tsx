import { ADMIN, ADMIN_TABS, tabIndexOf, type TabsOf } from "@/lib/admin-routes";
import { liveSessions, onboardingRows } from "@/lib/services/admin-platform-service";
import { AdminPage } from "../../_shell/admin-page";
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
      title="Sign-ins"
      subtitle="Who is signed in right now, and the accounts that have been created but never used."
      tabs={{ items: ADMIN_TABS.signIns, active: slug, href: (s) => ADMIN.signIns(s as TabsOf<"signIns">) }}
    >
      {slug === "now" ? (
        <SessionsTab data={{ sessions: await liveSessions() }} />
      ) : (
        <OnboardingTab data={{ onboarding: await onboardingRows() }} />
      )}
    </AdminPage>
  );
}
