"use server";

import { requirePlatformAdminUser } from "@/lib/access-control";
import { fromThrown, type Result } from "@/lib/result";
import { releaseHandsetBinding } from "@/lib/services/handset-release";

/**
 * Release a handset from the Admin Console's Handsets table.
 *
 * A platform administrator, with a recently proved password — the bar every
 * other console write sets, and the same one the table's own read sits behind.
 * No team narrowing: the console lists every salesman's phone, and the person
 * the sign-in refusal sends a salesman to is exactly this one.
 */
export async function releaseHandsetFromConsole(input: {
  deviceId: string;
  reason: string;
}): Promise<Result> {
  try {
    const user = await requirePlatformAdminUser();
    return await releaseHandsetBinding({ actor: user, deviceId: input.deviceId, reason: input.reason });
  } catch (e) {
    return fromThrown(e);
  }
}
