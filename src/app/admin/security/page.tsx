import type { Config } from "@/lib/config/registry";
import { listCollections } from "@/lib/config/entity-collections";
import {
  toConsole,
  type SchemaGroup,
  type SchemaTab,
} from "@/lib/config/schema-contract";
import { schemaForPage } from "@/lib/config/settings-schemas";
import { SETTINGS_PAGES } from "@/lib/config/settings-pages";
import { configWarnings, getConfig } from "@/lib/config/store";
import { adminContext, requirePlatformAdmin } from "../_shell/context";
import { SettingsEditor } from "../settings-editor";
import { SecurityFrame } from "../sign-ins/security-frame";

/**
 * Security & sign-ins › Policy: every `auth.*` setting — the lockout, the
 * console's password re-check, the codes — on the security screen beside the
 * sign-ins they govern.
 *
 * They are the SAME settings the Platform page edits, gathered rather than
 * copied: the fields are found in the settings schemas by key, so a sign-in
 * setting added to the registry appears here with no change to this page,
 * and saving goes through the one settings writer and its audit.
 */
export default async function SecurityPolicyPage() {
  await requirePlatformAdmin();
  const ctx = await adminContext();

  const groups: SchemaGroup[] = [];
  for (const page of SETTINGS_PAGES) {
    for (const tab of schemaForPage(page.id)?.tabs ?? []) {
      for (const g of tab.groups) {
        const fields = g.fields.filter((f) => f.key.startsWith("auth."));
        if (fields.length)
          groups.push({ label: g.label, note: g.note, fields });
      }
    }
  }
  const tab: SchemaTab = {
    key: "security-policy",
    label: "Sign-in policy",
    groups,
  };

  const [config, warnings, collections] = await Promise.all([
    getConfig(),
    configWarnings(),
    listCollections(),
  ]);
  const values: Record<string, unknown> = {};
  for (const g of groups)
    for (const f of g.fields) {
      if (f.control === "entity") continue;
      values[f.key] = toConsole(
        config[f.key as keyof Config],
        f.control,
        f.parts,
      );
    }

  return (
    <SecurityFrame active="policy">
      <SettingsEditor
        owner="Security"
        tab={tab}
        values={values}
        config={config}
        warnings={warnings.filter((w) => /password|code|sign/i.test(w))}
        canWrite={ctx.canWriteConfig}
        isPlatformAdmin={ctx.isPlatformAdmin}
        collections={collections}
      />
    </SecurityFrame>
  );
}
