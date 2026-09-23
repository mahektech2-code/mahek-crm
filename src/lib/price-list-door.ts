import "server-only";
import { canFor } from "@/lib/access-control";
import type { PricingApp } from "@/lib/price-list-views";

/**
 * WHETHER THIS DOOR DRAWS THE CONTROLS THAT CHANGE A PRICE LIST.
 *
 * Two questions, and both have to say yes. The capability is the person's —
 * `pricelist.manage`, which only the Accounts desk and the Founder Dashboard
 * carry (see `PRICE_DESK`). The MOUNT is the screen's: the CRM and the Sales
 * Dashboard are where prices are QUOTED, and Mahek's instruction was that
 * those two apps are read-only for price lists — for everybody, including
 * somebody who also holds the Accounts desk and could change the list from
 * there. A control drawn on a telecaller's screen because the person happens
 * to wear a second hat is a control a telecaller's screen should not have.
 *
 * The actions still check the capability themselves; this only decides what
 * is drawn.
 */
export async function priceListDoorCanManage(
  user: { id: string; role: string },
  app: PricingApp,
): Promise<boolean> {
  if (app === "crm" || app === "sales") return false;
  return canFor(user, "pricelist.manage");
}
