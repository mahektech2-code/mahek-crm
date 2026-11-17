import { notFound, redirect } from "next/navigation";
import { ADMIN, tabIndexOf } from "@/lib/admin-routes";
import type { Config } from "@/lib/config/registry";
import { listCollections } from "@/lib/config/entity-collections";
import { schemaFields, toConsole } from "@/lib/config/schema-contract";
import { schemaForPage } from "@/lib/config/settings-schemas";
import { settingsPage } from "@/lib/config/settings-pages";
import { configWarnings, getConfig } from "@/lib/config/store";
import { configDrift } from "@/lib/services/admin-platform-service";
import { adminContext, firstPageFor } from "../../../_shell/context";
import { SettingsScreen } from "../../_ui/settings-screen";

/**
 * One app's settings, one tab at a time.
 *
 * Every setting shown here is declared in `lib/config/registry.ts` and placed
 * by `lib/config/schema-contract.ts` — the console holds no copy of any of it,
 * so a setting added to the registry appears here with no change to this page.
 */
export default async function SettingsPageRoute({
  params,
}: {
  params: Promise<{ page: string; tab?: string[] }>;
}) {
  const { page: id, tab } = await params;
  const page = settingsPage(id);
  const schema = schemaForPage(id);
  if (!page || !schema) notFound();

  const ctx = await adminContext();
  if (!ctx.settingsPages.some((p) => p.id === id)) redirect(firstPageFor(ctx));

  const tabs = schema.tabs.map((t) => ({ slug: t.key, label: t.label }));
  const current = schema.tabs[tabIndexOf(tabs, tab?.[0])];

  const [config, warnings, collections] = await Promise.all([getConfig(), configWarnings(), listCollections()]);

  // Stored values, projected into the shapes the editor's controls edit.
  const values: Record<string, unknown> = {};
  for (const f of schemaFields(schema)) {
    if (f.control === "entity") continue;
    values[f.key] = toConsole(config[f.key as keyof Config], f.control, f.parts);
  }

  // A contradiction is shown on the page whose settings it names. All of them
  // are listed together under All settings, so none is shown nowhere.
  const labels = schemaFields(schema).map((f) => f.label.toLowerCase());
  const mine = warnings.filter((w) => labels.some((l) => w.toLowerCase().includes(l)));

  // How many settings on each page differ from their defaults — the count
  // beside each app in the list.
  const { rows: drift } = await configDrift();
  const drifted = new Set(drift.map((r) => r.key));
  const apps = ctx.settingsPages.map((p) => {
    const keys = schemaFields(schemaForPage(p.id)!).filter((f) => f.control !== "entity").map((f) => f.key);
    return { id: p.id, label: p.label, href: ADMIN.settingsFor(p.id), changed: keys.filter((k) => drifted.has(k)).length };
  });

  return (
    <SettingsScreen
      apps={apps}
      active={id}
      tabs={tabs.map((t) => ({ ...t, href: ADMIN.settingsFor(id, t.slug) }))}
      activeTab={current.key}
      owner={page.label}
      tab={current}
      values={values}
      config={config}
      warnings={mine}
      canWrite={ctx.canWriteConfig}
      isPlatformAdmin={ctx.isPlatformAdmin}
      collections={collections}
    />
  );
}
