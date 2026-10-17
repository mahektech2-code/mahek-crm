"use server";

import { revalidatePath } from "next/cache";
import { fromThrown, type Result } from "@/lib/result";
import {
  restoreLeads as restoreLeadsService,
  trashLeads as trashLeadsService,
  type TrashRefusal,
} from "@/lib/services/lead-trash-service";

/**
 * Deleting and restoring leads. The rules are in `lead-trash-service.ts`;
 * these are the doors, and each re-checks its capability there, because a
 * server action is a URL and a hidden button is not a permission.
 */

function refresh() {
  try {
    // Every screen a lead can be listed on reads fresh on its next render.
    revalidatePath("/", "layout");
  } catch {
    /* No request context — nothing cached to invalidate. */
  }
}

export async function trashLeads(input: {
  ids: string[];
  reason: string;
}): Promise<Result<{ moved: number; failed: TrashRefusal[] }>> {
  try {
    const r = await trashLeadsService({
      ids: Array.isArray(input?.ids) ? input.ids.map(String) : [],
      reason: String(input?.reason ?? ""),
    });
    if (r.ok) refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}

export async function restoreLeads(input: { ids: string[] }): Promise<Result<{ restored: number }>> {
  try {
    const r = await restoreLeadsService({ ids: Array.isArray(input?.ids) ? input.ids.map(String) : [] });
    if (r.ok) refresh();
    return r;
  } catch (e) {
    return fromThrown(e);
  }
}
