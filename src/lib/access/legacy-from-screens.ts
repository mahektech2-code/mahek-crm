import type { AppId } from "../apps";
import type { Role } from "../role-levels";
import { writeLevelsForApp } from "../modules";
import { ERP_POWERS } from "../erp/powers";
import { HRMS_POWERS } from "../hrms/powers";
import { TASK_POWERS } from "../tasks/permissions";
import type { Owner } from "./action-owners";
import { normaliseGrant, type AppGrantDraft } from "./permission-rules";
import { ERP_POWER_OWNERS, HRMS_POWER_OWNERS, TASK_POWER_OWNERS } from "./power-owners";
import { holdsAny, moduleShape } from "./screen-permissions";

/* ---------------------------------------------------------------------------
 * A SCREEN GRANT, WRITTEN BACK AS THE TABLES THE REST OF THE APP READS.
 *
 * The capability check and the scope read the screen model directly. Every
 * other reader — each app's sidebar and route gate (`app_module_access`), the
 * ERP's, HRMS's and Tasks' own access files (their power tables), anything
 * asking a level — goes on reading what it always read, so the save writes
 * those too, DERIVED from the ticks here and never typed by the dialog:
 *
 *   - modules: the screens held, plus a screen's old Write level where it has
 *     Edit (WhatsApp's "reply and send"); the handset is one module, `field.home`;
 *   - level: associate for Associate, manager for Manager and Everyone; admin
 *     for Admin on the Admin Console (the platform administrator) and for an
 *     app administrator kept at Everyone;
 *   - powers: each ERP, HRMS or Tasks power whose screen and tick are held.
 *
 * Pure, so the save and its tests run the same derivation.
 * ------------------------------------------------------------------------- */

export type LegacyGrant = {
  /** Module keys as `app_module_access` stores them. Empty means the app is not granted. */
  modules: string[];
  role: Role;
  /** The app's own powers, for the ERP, HRMS and Tasks; null elsewhere. */
  powers: string[] | null;
};

const POWERS: Partial<Record<AppId, { all: readonly string[]; owners: Record<string, Owner[]> }>> = {
  erp: { all: ERP_POWERS, owners: ERP_POWER_OWNERS },
  hrms: { all: HRMS_POWERS, owners: HRMS_POWER_OWNERS },
  tasks: { all: TASK_POWERS, owners: TASK_POWER_OWNERS },
};

export function legacyFromScreens(
  app: AppId,
  draft: AppGrantDraft,
  opts: { platformAdmin?: boolean; previousRole?: Role | null } = {},
): LegacyGrant {
  const grant = normaliseGrant(draft, moduleShape(app));
  const screens = [...grant.screens.keys()];

  let modules: string[];
  if (app === "field") modules = screens.length ? ["field.home"] : [];
  else {
    modules = [...screens];
    for (const [screen, write] of writeLevelsForApp(app)) if (grant.screens.get(screen)?.edit) modules.push(write);
  }

  const role: Role =
    (app === "admin" && opts.platformAdmin) || (opts.previousRole === "admin" && grant.position === "everyone")
      ? "admin"
      : grant.position === "associate"
        ? "associate"
        : "manager";

  const table = POWERS[app];
  const powers = table ? table.all.filter((p) => holdsAny(grant, table.owners[p] ?? [])) : null;
  return { modules, role, powers };
}
