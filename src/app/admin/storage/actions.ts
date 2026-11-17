"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdminUser } from "@/lib/access-control";
import { sweepAttendanceSelfies, sweepOrphans } from "@/lib/services/attachment-service";
import { ADMIN } from "@/lib/admin-routes";
import type { Result } from "@/lib/result";

/** "Sweep now": the hourly selfie sweep and the nightly orphan sweep, run at once under today's settings. */
export async function sweepStorageNow(): Promise<Result<{ swept: number }>> {
  try {
    await requirePlatformAdminUser();
    const [a, b] = await Promise.all([sweepAttendanceSelfies(), sweepOrphans()]);
    revalidatePath(ADMIN.storage);
    return { ok: true, data: { swept: a.swept + b.swept } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The sweep could not run." };
  }
}
