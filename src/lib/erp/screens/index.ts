import "server-only";
import type { ScreenModule } from "../server";
import { MASTER_SCREENS } from "./masters";
import { PURCHASE_SCREENS } from "./purchase";
import { PURCHASE_FLOW_SCREENS } from "./purchase-flow";
import { PRODUCTION_SCREENS } from "./production";
import { MOVEMENT_SCREENS } from "./movement";
import { SALES_SCREENS } from "./sales";
import { LOGISTICS_SCREENS } from "./logistics";
import { COMPLAINT_SCREENS } from "./complaints";
import { recipesScreen } from "./recipes";
import { alertsScreen } from "./alerts";
import { inboxScreen } from "./inbox";
import { UNIT_SCREENS } from "./units";
import { STOCK_CHECK_SCREENS } from "./stock-check";
import { SCRAP_SCREENS } from "./scrap";
import { RETURN_SCREENS } from "./returns";
import { CAN_GROUP_SCREENS } from "./can-groups";

/* ---------------------------------------------------------------------------
 * Every built ERP screen's server module, by screen key. A key with no module
 * here is a screen the registry lists but that is not built yet.
 * ------------------------------------------------------------------------- */

const ALL: ScreenModule[] = [...MASTER_SCREENS, ...PURCHASE_FLOW_SCREENS, ...PURCHASE_SCREENS, ...PRODUCTION_SCREENS, ...MOVEMENT_SCREENS, ...SALES_SCREENS, ...LOGISTICS_SCREENS, ...COMPLAINT_SCREENS, recipesScreen, alertsScreen, inboxScreen, ...UNIT_SCREENS, ...STOCK_CHECK_SCREENS, ...SCRAP_SCREENS, ...RETURN_SCREENS, ...CAN_GROUP_SCREENS];

const BY_KEY = new Map(ALL.map((m) => [m.key, m]));

export function screenModule(key: string): ScreenModule | undefined {
  return BY_KEY.get(key);
}

/** Every built module — for the scale test, which holds every one of them to the row cap. */
export function allScreenModules(): ScreenModule[] {
  return ALL;
}
