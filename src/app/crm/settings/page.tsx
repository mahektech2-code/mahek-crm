import { isManager, requireUser } from "@/lib/auth";
import { configWarnings, listSettings } from "@/lib/config/store";
import { recentJobRuns } from "@/lib/jobs";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { SettingsScreen } from "./settings-screen";

export const metadata = { title: "Configuration - MahekOne CRM" };

export default async function SettingsPage() {
  const user = await requireUser();

  // Telecallers get a plain explanation rather than a permission error — they
  // have no reason to be here, but no reason to be alarmed either.
  if (!isManager(user)) {
    return (
      <div className="max-w-[900px] px-6 pt-6 pb-10">
        <PageHeader title="Configuration" />
        <EmptyState
          title="Managers only"
          body="These are the thresholds the whole system runs on - buying cycles, escalation timing, targets. A manager can change them; ask if something looks wrong."
        />
      </div>
    );
  }

  const [settings, warnings, jobs] = await Promise.all([
    listSettings(),
    configWarnings(),
    recentJobRuns(12),
  ]);

  return (
    <SettingsScreen
      settings={settings.map((s) => ({
        key: s.key,
        type: s.type,
        category: s.category,
        label: s.label,
        description: s.description,
        value: s.value,
        default: s.default,
        isDefault: s.isDefault,
        min: s.min ?? null,
        max: s.max ?? null,
        options: s.options ? [...s.options] : null,
        updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
      }))}
      warnings={warnings}
      jobs={jobs.map((j) => ({
        id: j.id,
        job: j.job,
        startedAt: j.startedAt.toISOString(),
        finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
        ok: j.ok,
        recordsAffected: j.recordsAffected,
        detail: j.detail,
      }))}
    />
  );
}
