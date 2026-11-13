import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { lockerCredentials } from "@/db/schema";
import { today } from "@/lib/format";
import { rotationDue, type Tier } from "./engine";
import { lockerSettingsRow } from "./service";

/** How many active logins are older than their tier allows — the "Change due" badge. */
export async function rotationDueCount(): Promise<number> {
  const [rows, settings] = await Promise.all([
    db.select({ tier: lockerCredentials.tier, every: lockerCredentials.rotateEveryDays, last: lockerCredentials.lastRotatedAt, created: lockerCredentials.createdAt }).from(lockerCredentials).where(eq(lockerCredentials.active, true)),
    lockerSettingsRow(),
  ]);
  const day = today();
  return rows.filter((r) => rotationDue(r.last ?? r.created, r.every ?? settings.tiers[r.tier as Tier].rotateDays, day).due).length;
}
