import "server-only";
import { db } from "@/db";
import { appSettings, auditLog } from "@/db/schema";
import { randomUUID } from "node:crypto";
import {
  SETTINGS,
  defaultConfig,
  definition,
  validateSetting,
  checkConsistency,
  type Config,
  type SettingDefinition,
} from "./registry";

/* ---------------------------------------------------------------------------
 * The configuration store.
 *
 * Reading happens inside every engine call, so it is cached with a short
 * expiry. Writing validates, audits, and takes effect on the next read — no
 * restart, no redeploy.
 * ------------------------------------------------------------------------- */

const CACHE_MS = 30_000;

type Cache = { value: Config; readAt: number };
const globalForConfig = globalThis as unknown as { __mahekConfig?: Cache };

/**
 * Every setting, with stored values layered over the registry defaults. A key
 * that has never been written simply falls through to its default, so adding a
 * setting to the registry needs no migration.
 */
export async function getConfig(): Promise<Config> {
  const cached = globalForConfig.__mahekConfig;
  if (cached && Date.now() - cached.readAt < CACHE_MS) return cached.value;

  const rows = await db.select().from(appSettings);
  const value = defaultConfig();
  for (const row of rows) {
    if (definition(row.key)) {
      (value as Record<string, unknown>)[row.key] = row.value;
    }
  }

  globalForConfig.__mahekConfig = { value, readAt: Date.now() };
  return value;
}

/** Drop the cache so the next read sees a write immediately. */
export function invalidateConfig() {
  globalForConfig.__mahekConfig = undefined;
}

export async function getSetting<K extends keyof Config>(key: K): Promise<Config[K]> {
  return (await getConfig())[key];
}

/**
 * Writes the registry defaults for any key not already stored. Safe to re-run;
 * it never overwrites a value somebody has tuned.
 */
export async function seedConfig(): Promise<number> {
  const existing = new Set(
    (await db.select({ key: appSettings.key }).from(appSettings)).map((r) => r.key),
  );

  const missing = SETTINGS.filter((s) => !existing.has(s.key));
  if (missing.length) {
    await db.insert(appSettings).values(
      missing.map((s: SettingDefinition) => ({
        key: s.key,
        value: s.default as never,
        valueType: s.type,
        category: s.category,
        label: s.label,
        description: s.description,
      })),
    );
  }
  invalidateConfig();
  return missing.length;
}

export type ConfigUpdateResult =
  | { ok: true; warnings: string[] }
  | { ok: false; error: string };

/**
 * Validates at the point of the request, records the change, and reports any
 * cross-setting inconsistency the new value creates as a warning rather than a
 * hard failure — a manager mid-migration may legitimately want to tune one of
 * a related pair before the other.
 */
export async function updateSetting(
  key: string,
  rawValue: unknown,
  actorId: string,
): Promise<ConfigUpdateResult> {
  const def = definition(key);
  if (!def) return { ok: false, error: `Unknown setting "${key}".` };

  const validated = validateSetting(key, rawValue);
  if (!validated.ok) return { ok: false, error: validated.error };

  const current = await getConfig();
  const before = current[key as keyof Config];

  await db
    .insert(appSettings)
    .values({
      key,
      value: validated.value as never,
      valueType: def.type,
      category: def.category,
      label: def.label,
      description: def.description,
      updatedAt: new Date(),
      updatedById: actorId,
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: validated.value as never,
        updatedAt: new Date(),
        updatedById: actorId,
      },
    });

  await db.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId,
    action: "config.update",
    entityType: "app_setting",
    entityId: key,
    beforeState: { value: before } as never,
    afterState: { value: validated.value } as never,
  });

  invalidateConfig();

  const warnings = checkConsistency(await getConfig());
  return { ok: true, warnings };
}

/**
 * A whole section saved as one change set.
 *
 * The console edits several related settings at once — three escalation
 * thresholds, a set of aging buckets — and half-applying those leaves the
 * system briefly describing something nobody agreed to. So every value is
 * validated before any is written, the writes share one transaction, and the
 * resulting configuration is checked for consistency before the transaction
 * commits.
 *
 * A problem that was ALREADY present is not a reason to refuse: the stored
 * configuration may be inconsistent today, and refusing to save would trap
 * whoever is trying to fix one half of it.
 */
export async function updateSettings(
  entries: ReadonlyArray<{ key: string; value: unknown }>,
  actorId: string,
): Promise<
  | { ok: true; warnings: string[] }
  | { ok: false; error: string; fields: Array<{ field: string; message: string }> }
> {
  if (!entries.length) return { ok: true, warnings: [] };

  const fields: Array<{ field: string; message: string }> = [];
  const validated: Array<{ def: SettingDefinition; value: unknown }> = [];

  for (const entry of entries) {
    const def = definition(entry.key);
    if (!def) {
      fields.push({ field: entry.key, message: `Unknown setting "${entry.key}".` });
      continue;
    }
    const result = validateSetting(entry.key, entry.value);
    if (!result.ok) fields.push({ field: entry.key, message: result.error });
    else validated.push({ def, value: result.value });
  }

  if (fields.length) {
    return { ok: false, error: "Some values cannot be saved.", fields };
  }

  const before = await getConfig();
  const problemsBefore = new Set(checkConsistency(before));

  const after = { ...before } as Config;
  for (const v of validated) {
    (after as Record<string, unknown>)[v.def.key] = v.value;
  }
  const introduced = checkConsistency(after).filter((p) => !problemsBefore.has(p));
  if (introduced.length) {
    return {
      ok: false,
      error: introduced[0],
      fields: introduced.map((message) => ({ field: "", message })),
    };
  }

  await db.transaction(async (tx) => {
    for (const { def, value } of validated) {
      await tx
        .insert(appSettings)
        .values({
          key: def.key,
          value: value as never,
          valueType: def.type,
          category: def.category,
          label: def.label,
          description: def.description,
          updatedAt: new Date(),
          updatedById: actorId,
        })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: value as never, updatedAt: new Date(), updatedById: actorId },
        });

      // One entry per setting, not one per change set — the audit answers
      // "what happened to this threshold", which a bundled row cannot.
      await tx.insert(auditLog).values({
        id: `aud_${randomUUID().slice(0, 12)}`,
        actorId,
        action: "config.update",
        entityType: "app_setting",
        entityId: def.key,
        beforeState: { value: before[def.key as keyof Config] } as never,
        afterState: { value } as never,
      });
    }
  });

  invalidateConfig();
  return { ok: true, warnings: checkConsistency(await getConfig()) };
}

/** For the manager configuration screen: definitions plus current values. */
export type SettingRow = SettingDefinition & {
  value: unknown;
  isDefault: boolean;
  updatedAt: Date | null;
  updatedById: string | null;
};

export async function listSettings(): Promise<SettingRow[]> {
  const config = await getConfig();
  const rows = await db.select().from(appSettings);
  const meta = new Map(rows.map((r) => [r.key, r]));

  return (SETTINGS as readonly SettingDefinition[]).map((s) => ({
    ...s,
    value: config[s.key as keyof Config],
    isDefault:
      JSON.stringify(config[s.key as keyof Config]) === JSON.stringify(s.default),
    updatedAt: meta.get(s.key)?.updatedAt ?? null,
    updatedById: meta.get(s.key)?.updatedById ?? null,
  }));
}

export async function configWarnings(): Promise<string[]> {
  return checkConsistency(await getConfig());
}
