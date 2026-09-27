import "server-only";
import type { ScreenModule } from "../server";
import { MASTER_SCREENS } from "./masters";
import { PURCHASE_SCREENS } from "./purchase";
import { PRODUCTION_SCREENS } from "./production";
import { MOVEMENT_SCREENS } from "./movement";
import { SALES_SCREENS } from "./sales";

/* ---------------------------------------------------------------------------
 * Every built ERP screen's server module, by screen key. A key with no module
 * here is a screen the registry lists but that is not built yet.
 * ------------------------------------------------------------------------- */

const ALL: ScreenModule[] = [...MASTER_SCREENS, ...PURCHASE_SCREENS, ...PRODUCTION_SCREENS, ...MOVEMENT_SCREENS, ...SALES_SCREENS];

const BY_KEY = new Map(ALL.map((m) => [m.key, m]));

export function screenModule(key: string): ScreenModule | undefined {
  return BY_KEY.get(key);
}
