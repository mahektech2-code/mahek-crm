import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { webApps } from "@/lib/apps";
import { AppSwitcher } from "@/components/shell/app-switcher";
import { FeedbackButton } from "@/components/shell/feedback-button";
import { initialsOf } from "@/lib/format";
import { hatForHeader } from "@/lib/hat-for-header";
import { FounderShell } from "./founder-shell";

/**
 * The founder's two working DESKS — price lists and WhatsApp — in the shell
 * they were built in. The gate itself is the parent layout's.
 */
export default async function FounderDesksLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [apps, modules, hat] = await Promise.all([
    listUserApps(user.id),
    listUserModules(user.id, "founder"),
    hatForHeader(user, "founder"),
  ]);
  return (
    <FounderShell
      user={{ name: user.name, role: hat.label, roleSentence: hat.sentence, initials: initialsOf(user.name) }}
      allowed={modules.map((m) => m.href)}
      switcher={apps.length > 1 ? <AppSwitcher apps={webApps(apps)} current="founder" /> : null}
      feedback={<FeedbackButton />}
    >
      {children}
    </FounderShell>
  );
}
