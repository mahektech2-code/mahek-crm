import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appModuleAccess, erpUserPowers } from "@/db/schema";
import type { AppId } from "@/lib/apps";
import { moduleKeysForApp } from "@/lib/modules";

/* ---------------------------------------------------------------------------
 * The two writes every path that changes somebody's access goes through — the
 * Access dialog (`setAccess`) and an edit to an ERP designation applied to the
 * people who hold it. They live here, not in `actions/access.ts`, because an
 * export from a "use server" file is a URL anybody signed in can post to.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Write one app's module rows.
 *
 * Every module ticked stores NO rows rather than a row each. That is what
 * makes "the whole app" a single fact instead of fourteen that can go stale:
 * add a fifteenth screen to the CRM tomorrow and everybody who holds the whole
 * app gets it, while everybody who was deliberately narrowed does not — which
 * is what both of those decisions meant.
 */
export async function writeModules(tx: Tx, userId: string, app: AppId, modules: string[], grantedById: string) {
  await tx.delete(appModuleAccess).where(and(eq(appModuleAccess.userId, userId), eq(appModuleAccess.app, app)));

  if (modules.length >= moduleKeysForApp(app).length) return;

  await tx.insert(appModuleAccess).values(
    modules.map((module) => ({
      id: newId("mod"),
      userId,
      app,
      module,
      grantedById,
    })),
  );
}

/** Replace somebody's ERP powers with this list. */
export async function writeErpPowers(tx: Tx, userId: string, powers: string[], by: string) {
  await tx.delete(erpUserPowers).where(eq(erpUserPowers.userId, userId));
  if (powers.length) await tx.insert(erpUserPowers).values(powers.map((power) => ({ userId, power, grantedById: by })));
}
