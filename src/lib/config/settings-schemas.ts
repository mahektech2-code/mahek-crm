import { pageSchema, schemaFields, type AppSchema } from "./schema-contract";
import { SETTINGS_PAGES } from "./settings-pages";
import type { AppId } from "../apps";

/* ---------------------------------------------------------------------------
 * Which schema each settings page renders. Pure, like the schemas themselves,
 * so the page and the console's own counts read the same answer.
 * ------------------------------------------------------------------------- */

const cache = new Map<string, AppSchema>();

/** The schema a page renders. Pure, so it is worked out once per process. */
export function schemaForPage(id: string): AppSchema | null {
  if (!SETTINGS_PAGES.some((p) => p.id === id)) return null;
  if (!cache.has(id)) cache.set(id, pageSchema(id));
  return cache.get(id)!;
}

/** The first page an app's holders configure, or null where it has none. */
export function settingsPageFor(app: AppId): string | null {
  return SETTINGS_PAGES.find((p) => p.owners.includes(app))?.id ?? null;
}

/** How many settings an app's own page declares, or null where it has none. */
export function settingsCountFor(app: AppId): number | null {
  const id = settingsPageFor(app);
  if (!id) return null;
  return schemaFields(schemaForPage(id)!).filter((f) => f.control !== "entity").length;
}

/**
 * Where one setting is edited — its page and tab — or null if no page shows
 * it. `settings-pages.test.ts` holds that null never happens, so a setting
 * added to the registry cannot be left with nowhere to be changed.
 */
export function settingAddress(key: string): { page: string; tab: string; tabLabel: string } | null {
  for (const p of SETTINGS_PAGES) {
    const schema = schemaForPage(p.id);
    for (const t of schema?.tabs ?? []) {
      if (t.groups.some((g) => g.fields.some((f) => f.key === key))) {
        return { page: p.id, tab: t.key, tabLabel: t.label };
      }
    }
  }
  return null;
}
