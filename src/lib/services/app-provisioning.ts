import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { appAccess, appModuleAccess } from "@/db/schema";
import type { AppId } from "@/lib/apps";
import { modulesForApp } from "@/lib/modules";

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/**
 * Grant somebody an app the way a person ticking it on the Access screen
 * would: the `app_access` row, plus explicit `app_module_access` rows for
 * everything except the app's `offByDefault` modules (Calling desk, Sales
 * Manager).
 *
 * `npm run app:grant`, the provisioning endpoint and the back-office bulk
 * provision all write an `app_access` row with no module rows at all, because
 * none of the three knows modules exist. `moduleAllowed()` reads "no rows"
 * as "every module" — correct for an app with nothing marked `offByDefault`,
 * and the reason a grant from a terminal still opens whole rather than opens
 * empty — but it is exactly the state migration `0170` had to backfill AWAY
 * FROM for every existing whole-CRM account, because it also hands over a
 * module meant to be granted a person at a time. A path that creates a new
 * grant this way reproduces the state 0170 fixed, for every account made
 * after it, which none of the three original callers protected against.
 *
 * This does not touch `moduleAllowed()` or its semantics — an administrator
 * still reaches every `offByDefault` module automatically, and `explicitOnly`
 * modules (`sales.lead-pipeline`) are `offByDefault` too, so they are already
 * excluded from what gets written here. Nothing about existing grants moves:
 * this only runs on the INSERT path for a brand-new `app_access` row.
 *
 * Reads `modulesForApp(app)` live rather than a fixed list, so it never goes
 * stale as `offByDefault` modules are added or removed from the registry —
 * the same reasoning migration `0170`'s own header gives for keeping ITS list
 * a frozen snapshot, applied the other way: a one-time backfill has to be
 * frozen, but code that runs on every future grant has to track the registry
 * or it starts lying the day somebody adds the next one.
 *
 * Skips the module insert entirely for an app with no `offByDefault` modules
 * at all — every app but `crm` and `sales` today — because writing every one
 * of its modules out explicitly would mean the same thing as zero rows and
 * cost real writes to say it.
 */
export async function grantAppWithDefaultModules(
  client: Pick<typeof db, "insert">,
  args: { userId: string; app: AppId; grantedById: string | null },
): Promise<void> {
  const { userId, app, grantedById } = args;

  await client.insert(appAccess).values({ id: newId("acc"), userId, app, grantedById });

  const modules = modulesForApp(app);
  if (!modules.some((m) => m.offByDefault)) return;

  const keep = modules.filter((m) => !m.offByDefault).map((m) => m.key);
  if (!keep.length) return;

  await client.insert(appModuleAccess).values(
    keep.map((module) => ({ id: newId("mod"), userId, app, module, grantedById })),
  );
}
