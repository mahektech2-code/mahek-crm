import "server-only";
import type { ScreenModule } from "../server";
import { applyTicks } from "../action-ticks";
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
import { uomsScreen } from "./uoms";
import { STOCK_CHECK_SCREENS } from "./stock-check";
import { SCRAP_SCREENS } from "./scrap";
import { RETURN_SCREENS } from "./returns";
import { CAN_GROUP_SCREENS } from "./can-groups";
import { MONEY_SCREENS } from "./money";
import { ORDER_HUB_SCREENS } from "./order-hub";

/* ---------------------------------------------------------------------------
 * Every built ERP screen's server module, by screen key. A key with no module
 * here is a screen the registry lists but that is not built yet.
 * ------------------------------------------------------------------------- */

const ALL: ScreenModule[] = [...MASTER_SCREENS, ...PURCHASE_FLOW_SCREENS, ...PURCHASE_SCREENS, ...PRODUCTION_SCREENS, ...MOVEMENT_SCREENS, ...SALES_SCREENS, ...LOGISTICS_SCREENS, ...COMPLAINT_SCREENS, recipesScreen, alertsScreen, inboxScreen, ...UNIT_SCREENS, uomsScreen, ...STOCK_CHECK_SCREENS, ...SCRAP_SCREENS, ...RETURN_SCREENS, ...CAN_GROUP_SCREENS, ...MONEY_SCREENS, ...ORDER_HUB_SCREENS];

/* Every page's actions are marked against the person's Edit and Delete ticks
   as it loads (`action-ticks.ts`) — Purchase first, every ERP screen since
   Nov 2026. Every list, export, combined view and record reads through here,
   so none of them can offer an act the server will refuse. */
const ticked = (m: ScreenModule): ScreenModule => ({ ...m, load: async (ctx, scope) => applyTicks(ctx, m.key, await m.load(ctx, scope)) });

const BY_KEY = new Map(ALL.map((m) => [m.key, ticked(m)]));

export function screenModule(key: string): ScreenModule | undefined {
  return BY_KEY.get(key);
}

/** Every built module — for the scale test, which holds every one of them to the row cap. */
export function allScreenModules(): ScreenModule[] {
  return ALL;
}
