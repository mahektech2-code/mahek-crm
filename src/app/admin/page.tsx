import { APPS } from "@/lib/apps";
import { ADMIN } from "@/lib/admin-routes";
import { settingsPageFor } from "@/lib/config/settings-schemas";
import { attentionItems, platformHealth, usageStats } from "@/lib/services/admin-platform-service";
import { AdminPage } from "./_shell/admin-page";
import { requirePlatformAdmin } from "./_shell/context";
import { AppsTable, AttentionTab, FactTiles } from "./platform-real";

/**
 * Where a platform administrator starts: what needs them, a handful of figures
 * about the platform, and every app once.
 *
 * It was the Overview section's first three tabs — Attention, Health and Usage
 * — plus the Registry tab under Apps, which drew Health's app table a second
 * time. One page, read top to bottom, in the order somebody asks the questions.
 */
export default async function AdminHome() {
  await requirePlatformAdmin();
  const [attention, health, usage] = await Promise.all([attentionItems(), platformHealth(), usageStats()]);

  const settingsHref: Record<string, string | null> = Object.fromEntries(
    APPS.map((a) => {
      const page = settingsPageFor(a.id);
      return [a.id, page ? ADMIN.settingsFor(page) : null];
    }),
  );

  return (
    <AdminPage title="Home" subtitle="What needs an administrator today, and how the platform stands.">
      <AttentionTab data={{ attention }} />
      <FactTiles facts={[...health.facts, ...usage.facts]} />
      <AppsTable apps={health.apps} settingsHref={settingsHref} />
    </AdminPage>
  );
}
